import { nanoid } from 'nanoid';

const JSON_CONTENT_TYPE = { 'Content-Type': 'application/json' };

// 转发 OpenAI 兼容的 API 请求
export async function handleChatCompletions(request, env) {
  const startTime = Date.now();
  const url = new URL(request.url);
  const apiKey = await selectApiKey(env);
  
  try {
    // 克隆请求以便多次使用
    const requestClone = request.clone();
    const requestData = await requestClone.json();
    const model = requestData.model || '';
    
    // 创建转发请求
    const forwardRequest = new Request(`${env.BASE_URL}${url.pathname}${url.search}`, {
      method: request.method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestData),
      redirect: 'follow'
    });
    
    // 发送请求到 SiliconFlow API
    const response = await fetch(forwardRequest);
    
    // 检查是否为流式响应
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('text/event-stream')) {
      return handleStreamingRequest(request, apiKey, requestData, env, model, startTime);
    }
    
    const responseData = await response.json();
    
    // 记录 token 使用情况
    if (response.ok && responseData.usage) {
      const { prompt_tokens, completion_tokens, total_tokens } = responseData.usage;
      
      // 记录 API 调用
      await logApiCall(
        env,
        apiKey,
        model,
        prompt_tokens || 0,
        completion_tokens || 0
      );
    }
    
    // 计算响应时间
    const responseTime = Date.now() - startTime;
    
    // 记录请求
    await logRequest(request, response.status, responseTime, apiKey, env);
    
    // 返回响应
    return new Response(JSON.stringify(responseData), {
      status: response.status,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Error forwarding request:', error);
    
    // 记录错误
    await logRequest(request, 500, Date.now() - startTime, apiKey, env);
    
    return new Response(JSON.stringify({
      error: {
        message: error.message || '处理您的请求时发生错误'
      }
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
}

// 处理普通请求
async function handleNormalRequest(request, apiKey, requestBody, env, model, startTime) {
  const url = new URL(request.url);
  const targetUrl = `${env.BASE_URL}${url.pathname}${url.search}`;
  
  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    
    const responseTime = Date.now() - startTime;
    const responseData = await response.json();
    
    // 记录使用情况
    if (responseData.usage) {
      const { prompt_tokens, completion_tokens, total_tokens } = responseData.usage;
      
      await logCompletion(
        env,
        apiKey,
        model,
        startTime / 1000, // 转换为秒
        prompt_tokens || 0,
        completion_tokens || 0,
        total_tokens || 0
      );
    }
    
    return new Response(JSON.stringify(responseData), {
      status: response.status,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('API request error:', error);
    return new Response(JSON.stringify({ error: '请求处理失败' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 处理流式请求
async function handleStreamingRequest(request, apiKey, requestBody, env, model, startTime) {
  const url = new URL(request.url);
  const targetUrl = `${env.BASE_URL}${url.pathname}${url.search}`;
  
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  
  // 启动异步处理流
  (async () => {
    try {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        writer.write(new TextEncoder().encode(`data: ${JSON.stringify({ error: errorText })}\n\n`));
        writer.close();
        return;
      }
      
      const reader = response.body.getReader();
      let completionTokens = 0;
      let inputTokens = requestBody.messages.reduce((acc, msg) => acc + msg.content.length / 4, 0); // 粗略估计输入tokens
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = new TextDecoder().decode(value);
        await writer.write(value);
        
        // 尝试估计完成 token
        if (chunk.includes('content')) {
          completionTokens += chunk.length / 4; // 粗略估计
        }
      }
      
      // 记录使用情况
      await logCompletion(
        env,
        apiKey,
        model,
        startTime / 1000, // 转换为秒
        Math.round(inputTokens),
        Math.round(completionTokens),
        Math.round(inputTokens + completionTokens)
      );
      
    } catch (error) {
      console.error('Streaming error:', error);
      writer.write(new TextEncoder().encode(`data: ${JSON.stringify({ error: '流处理失败' })}\n\n`));
    } finally {
      writer.close();
    }
  })();
  
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  });
}

// 记录完成情况
async function logCompletion(env, apiKey, model, callTime, inputTokens, outputTokens, totalTokens) {
  try {
    // 查找 API 密钥 ID
    const { results } = await env.DB.prepare(
      'SELECT id FROM api_keys WHERE key = ?'
    ).bind(apiKey).all();
    
    const apiKeyId = results && results.length > 0 ? results[0].id : null;
    
    // 记录日志
    await env.DB.prepare(
      'INSERT INTO logs (id, timestamp, api_key_id, model, input_tokens, output_tokens, total_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      nanoid(),
      Math.floor(callTime * 1000),
      apiKeyId,
      model,
      inputTokens,
      outputTokens,
      totalTokens
    ).run();
    
    // 更新 API 密钥使用情况
    if (apiKeyId) {
      await env.DB.prepare(
        'UPDATE api_keys SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?'
      ).bind(Date.now(), apiKeyId).run();
    }
  } catch (error) {
    console.error('Error logging completion:', error);
  }
}

// 选择 API 密钥
async function selectApiKey(env, excludeKey = null) {
  try {
    // 从 D1 获取所有可用的 API 密钥
    let query = 'SELECT id, key FROM api_keys WHERE is_active = 1';
    if (excludeKey) {
      query += ' AND key != ?';
    }
    
    const statement = env.DB.prepare(query);
    const { results } = excludeKey ? await statement.bind(excludeKey).all() : await statement.all();
    
    if (results && results.length > 0) {
      // 随机选择一个密钥
      const randomIndex = Math.floor(Math.random() * results.length);
      return results[randomIndex].key;
    }
  } catch (error) {
    console.error('Error selecting API key:', error);
  }
  
  // 如果没有可用的密钥，返回默认密钥
  return env.API_KEY;
}

// 记录 API 调用日志
async function logApiCall(env, apiKey, model, inputTokens, outputTokens) {
  try {
    const totalTokens = inputTokens + outputTokens;
    
    // 查找 API 密钥 ID
    const apiKeyResult = await env.DB.prepare(
      'SELECT id FROM api_keys WHERE key = ?'
    ).bind(apiKey).first();
    
    const apiKeyId = apiKeyResult ? apiKeyResult.id : null;
    
    await env.DB.prepare(
      'INSERT INTO logs (id, timestamp, api_key_id, request_path, model, input_tokens, output_tokens, total_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      nanoid(),
      Date.now(),
      apiKeyId,
      '/v1/chat/completions', // 默认路径
      model || '',
      inputTokens || 0,
      outputTokens || 0,
      totalTokens || 0
    ).run();
    
    // 更新 API 密钥使用情况
    if (apiKeyId) {
      await env.DB.prepare(
        'UPDATE api_keys SET last_used_at = ?, usage_count = usage_count + 1 WHERE id = ?'
      ).bind(Date.now(), apiKeyId).run();
    }
  } catch (error) {
    console.error('Error logging API call:', error);
  }
}

// 记录请求
async function logRequest(request, statusCode, responseTime, apiKey, env) {
  try {
    const url = new URL(request.url);
    const requestIp = request.headers.get('CF-Connecting-IP') || 'unknown';
    
    let apiKeyId = null;
    try {
      const result = await env.DB.prepare(
        'SELECT id FROM api_keys WHERE key = ?'
      ).bind(apiKey).first();
      
      apiKeyId = result ? result.id : null;
    } catch (error) {
      console.error('Error finding API key ID:', error);
    }
    
    await env.DB.prepare(
      'INSERT INTO logs (id, timestamp, request_ip, request_path, api_key_id, status_code, response_time, total_tokens, input_tokens, output_tokens, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      nanoid(),
      Date.now(),
      requestIp,
      url.pathname + url.search,
      apiKeyId,
      statusCode,
      responseTime,
      0,
      0,
      0,
      ''
    ).run();
  } catch (error) {
    console.error('Error logging request:', error);
  }
}

export async function handleModels(request, env) {
  const apiKey = await selectApiKey(env);
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "没有可用的api-key" }), {
      status: 500,
      headers: JSON_CONTENT_TYPE
    });
  }

  const forwardHeaders = new Headers(request.headers);
  forwardHeaders.set('Authorization', `Bearer ${apiKey}`);

  try {
    const response = await fetch(`${env.BASE_URL}/v1/models`, {
      headers: forwardHeaders,
      timeout: 30000
    });
    const data = await response.json();
    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: JSON_CONTENT_TYPE
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: `请求转发失败: ${error.message}` }), {
      status: 500,
      headers: JSON_CONTENT_TYPE
    });
  }
}