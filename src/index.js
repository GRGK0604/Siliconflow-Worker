/**
 * 硅基 KEY 池 - Cloudflare Worker 版本
 * 
 * 这个文件实现了 KEY 池的主要功能，包括：
 * - 用户认证
 * - API Key 管理
 * - 请求转发
 * - 日志记录
 */

// 添加必要的导入
import { nanoid } from 'nanoid';
import { handleChatCompletions, handleModels } from './api-proxy.js';
import { importApiKeys, exportApiKeys, refreshApiKeys, getApiKeysDetails, refreshSingleApiKey, refreshBatchApiKeys, updateApiKeyStatus, refreshAllKeys, updateKeysStatus, deleteZeroBalanceKeys } from './key-management.js';
import { handleAdminLogin, handleAdminLogout, getStats, getLogs, clearLogs } from './admin.js';
import { getAssetFromKV } from '@cloudflare/kv-asset-handler';

// 内容类型
const HTML_CONTENT_TYPE = { "Content-Type": "text/html; charset=utf-8" };
const JSON_CONTENT_TYPE = { "Content-Type": "application/json; charset=utf-8" };

// 辅助函数
function generateId() {
  return crypto.randomUUID();
}

export function getCookieValue(cookieString, name) {
  if (!cookieString) return null;
  const cookies = cookieString.split(';');
  for (const cookie of cookies) {
    const [cookieName, cookieValue] = cookie.trim().split('=');
    if (cookieName === name) {
      return cookieValue;
    }
  }
  return null;
}

// 会话管理
export async function createSession(env, username) {
  const sessionId = generateId();
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24小时过期
  
  // 清理过期会话
  await env.DB.prepare(
    'DELETE FROM sessions WHERE expires_at < ?'
  ).bind(Date.now()).run();
  
  // 存储会话到 D1 数据库
  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at, data) VALUES (?, ?, ?, ?, ?)'
  ).bind(
    sessionId,
    username,
    Date.now(),
    expiresAt,
    JSON.stringify({ username, createdAt: Date.now() })
  ).run();
  
  return sessionId;
}

export async function validateSession(env, request) {
  const cookies = request.headers.get("Cookie");
  const sessionId = getCookieValue(cookies, "session");
  
  if (!sessionId) return false;
  
  // 清理过期会话
  await env.DB.prepare(
    'DELETE FROM sessions WHERE expires_at < ?'
  ).bind(Date.now()).run();
  
  // 从 D1 数据库查询会话
  const { results } = await env.DB.prepare(
    'SELECT * FROM sessions WHERE id = ? AND expires_at > ?'
  ).bind(sessionId, Date.now()).all();
  
  return results && results.length > 0;
}

// 日志记录
async function logRequest(request, statusCode, responseTime, apiKey, env) {
  try {
    const url = new URL(request.url);
    const requestIp = request.headers.get('CF-Connecting-IP') || 'unknown';
    
    // 查找 API 密钥 ID
    let apiKeyId = null;
    try {
      const result = await env.DB.prepare(
        'SELECT id FROM api_keys WHERE key = ?'
      ).bind(apiKey).first();
      
      apiKeyId = result ? result.id : null;
    } catch (error) {
      console.error('Error finding API key ID:', error);
    }
    
    // 记录日志
    await env.DB.prepare(
      'INSERT INTO logs (id, timestamp, request_ip, request_path, api_key_id, status_code, response_time) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      nanoid(),
      Date.now(),
      requestIp,
      url.pathname,
      apiKeyId,
      statusCode,
      responseTime
    ).run();
  } catch (error) {
    console.error('Error logging request:', error);
  }
}

// 选择 API 密钥
async function selectApiKey(env) {
  try {
    // 从数据库中获取活跃的 API 密钥
    const { results } = await env.DB.prepare(
      'SELECT key FROM api_keys WHERE is_active = 1 ORDER BY RANDOM() LIMIT 1'
    ).all();
    
    if (results && results.length > 0) {
      // 更新最后使用时间
      await env.DB.prepare(
        'UPDATE api_keys SET last_used_at = ?, usage_count = usage_count + 1 WHERE key = ?'
      ).bind(Date.now(), results[0].key).run();
      
      return results[0].key;
    }
    
    // 如果没有找到活跃的 API 密钥，返回环境变量中的默认密钥
    return env.API_KEY;
  } catch (error) {
    console.error('Error selecting API key:', error);
    return env.API_KEY;
  }
}

// 删除 API 密钥
async function deleteApiKey(keyId, env) {
  try {
    await env.DB.prepare(
      'DELETE FROM api_keys WHERE id = ?'
    ).bind(keyId).run();
    
    return new Response(JSON.stringify({
      message: 'API key deleted successfully'
    }), {
      headers: JSON_CONTENT_TYPE
    });
  } catch (error) {
    console.error('Error deleting API key:', error);
    return new Response(JSON.stringify({
      error: 'Failed to delete API key'
    }), {
      status: 500,
      headers: JSON_CONTENT_TYPE
    });
  }
}

// 处理错误页面
async function serveErrorPage(request, errorCode, env, ctx) {
  try {
    // 确定错误页面路径
    let errorPagePath = '/404.html';
    if (errorCode === 500) {
      errorPagePath = '/500.html';
    } else if (errorCode === 401) {
      errorPagePath = '/401.html';
    }

    // 直接从 KV 存储中获取错误页面内容
    const errorPageUrl = new URL(request.url);
    errorPageUrl.pathname = errorPagePath;
    
    // 创建一个新的请求对象
    const errorPageRequest = new Request(errorPageUrl.toString(), {
      method: 'GET',
      headers: new Headers({
        'Accept': 'text/html'
      })
    });
    
    // 使用 getAssetFromKV 获取错误页面
    return await getAssetFromKV(
      {
        request: errorPageRequest,
        waitUntil: ctx.waitUntil.bind(ctx),
      },
      {
        ASSET_NAMESPACE: env.STATIC_CONTENT,
        ASSET_MANIFEST: env.__STATIC_CONTENT_MANIFEST,
        cacheControl: {
          browserTTL: 0,
          edgeTTL: 0,
          bypassCache: true,
        },
        mapRequestToAsset: (req) => {
          // 确保请求直接指向错误页面
          const url = new URL(req.url);
          url.pathname = errorPagePath;
          return new Request(url.toString(), req);
        },
      }
    ).then(response => {
      // 返回错误页面，保持正确的状态码
      return new Response(response.body, {
        status: errorCode,
        headers: {
          'Content-Type': 'text/html; charset=UTF-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
        }
      });
    });
  } catch (error) {
    console.error(`Error serving ${errorCode} page:`, error.message);
    
    // 如果无法获取错误页面，返回简单的文本响应
    const fallbackMessages = {
      401: 'Unauthorized - 未授权访问',
      404: 'Not Found - 页面未找到',
      500: 'Internal Server Error - 服务器内部错误'
    };
    
    return new Response(fallbackMessages[errorCode] || 'Error', { 
      status: errorCode,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

// 导出模块格式的处理函数
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 在处理静态资源之前添加日志
    console.log('Handling request for:', url.pathname);
    
    // 处理登录请求
    if (url.pathname === '/login' && request.method === 'POST') {
      return handleAdminLogin(request, env);
    }

    // 处理退出请求
    if (url.pathname === '/logout') {
      return handleAdminLogout(request, env);
    }
    
    // 处理静态资源请求
    if (url.pathname === '/' || url.pathname === '/index.html') {
      // 检查用户是否已登录
      const isValidSession = await validateSession(env, request);
      
      if (isValidSession) {
        // 已登录，重定向到管理页面
        return new Response(null, {
          status: 302,
          headers: {
            'Location': '/admin'
          }
        });
      } else {
        // 未登录，显示首页
        try {
          return await getAssetFromKV(
            {
              request,
              waitUntil: ctx.waitUntil.bind(ctx),
            },
            {
              ASSET_NAMESPACE: env.STATIC_CONTENT,
              ASSET_MANIFEST: env.__STATIC_CONTENT_MANIFEST,
              mapRequestToAsset: req => new Request(`${new URL(req.url).origin}/index.html`, req),
            }
          );
        } catch (error) {
          console.error('Error serving index page:', error);
          // 如果找不到 index.html，返回一个简单的响应
          return new Response('Welcome to Silicon Key Pool. <a href="/admin">Login</a>', {
            headers: { 'Content-Type': 'text/html' }
          });
        }
      }
    }
    
    // 处理管理页面请求
    if (url.pathname === '/admin' || url.pathname === '/admin.html') {
      // 验证会话
      const isValidSession = await validateSession(env, request);
      if (!isValidSession) {
        return serveErrorPage(request, 401, env, ctx);
      }
      
      try {
        return await getAssetFromKV(
          {
            request,
            waitUntil: ctx.waitUntil.bind(ctx),
          },
          {
            ASSET_NAMESPACE: env.STATIC_CONTENT,
            ASSET_MANIFEST: env.__STATIC_CONTENT_MANIFEST,
            mapRequestToAsset: req => new Request(`${new URL(req.url).origin}/admin.html`, req),
          }
        );
      } catch (error) {
        console.error('Error serving admin page:', error);
        return serveErrorPage(request, 500, env, ctx);
      }
    }
    
    // 处理密钥管理页面请求
    if (url.pathname === '/keys' || url.pathname === '/keys.html') {
      // 验证会话
      const isValidSession = await validateSession(env, request);
      if (!isValidSession) {
        return serveErrorPage(request, 401, env, ctx);
      }
      
      try {
        return await getAssetFromKV(
          {
            request,
            waitUntil: ctx.waitUntil.bind(ctx),
          },
          {
            ASSET_NAMESPACE: env.STATIC_CONTENT,
            ASSET_MANIFEST: env.__STATIC_CONTENT_MANIFEST,
            mapRequestToAsset: req => new Request(`${new URL(req.url).origin}/keys.html`, req),
          }
        );
      } catch (error) {
        console.error('Error serving keys page:', error);
        return serveErrorPage(request, 500, env, ctx);
      }
    }
    
    // 处理密钥管理相关的API端点
    if (url.pathname === '/keys_details') {
      // 验证会话
      const isValidSession = await validateSession(env, request);
      if (!isValidSession) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: JSON_CONTENT_TYPE
        });
      }
      return getApiKeysDetails(env);
    } else if (url.pathname.startsWith('/refresh_key/') && request.method === 'POST') {
      // 验证会话
      const isValidSession = await validateSession(env, request);
      if (!isValidSession) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: JSON_CONTENT_TYPE
        });
      }
      return refreshSingleApiKey(request, env);
    } else if (url.pathname === '/refresh_keys' && request.method === 'POST') {
      // 验证会话
      const isValidSession = await validateSession(env, request);
      if (!isValidSession) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: JSON_CONTENT_TYPE
        });
      }
      return refreshBatchApiKeys(request, env);
    } else if (url.pathname === '/refresh_all_keys' && request.method === 'POST') {
      // 验证会话
      const isValidSession = await validateSession(env, request);
      if (!isValidSession) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: JSON_CONTENT_TYPE
        });
      }
      return refreshAllKeys(env);
    } else if (url.pathname.startsWith('/update_key_status/') && request.method === 'POST') {
      // 验证会话
      const isValidSession = await validateSession(env, request);
      if (!isValidSession) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: JSON_CONTENT_TYPE
        });
      }
      return updateApiKeyStatus(request, env);
    } else if (url.pathname === '/update_keys_status' && request.method === 'POST') {
      // 验证会话
      const isValidSession = await validateSession(env, request);
      if (!isValidSession) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: JSON_CONTENT_TYPE
        });
      }
      return updateKeysStatus(request, env);
    } else if (url.pathname === '/delete_zero_balance_keys' && request.method === 'POST') {
      // 验证会话
      const isValidSession = await validateSession(env, request);
      if (!isValidSession) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: JSON_CONTENT_TYPE
        });
      }
      return deleteZeroBalanceKeys(env);
    }
    
    // 处理 API 密钥请求
    if (url.pathname === '/api/key') {
      // 验证请求
      if (env.API_KEY && request.headers.get("Authorization") !== `Bearer ${env.API_KEY}`) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: JSON_CONTENT_TYPE
        });
      }
      
      // 获取 API 密钥
      const apiKey = await selectApiKey(env);
      return new Response(JSON.stringify({ key: apiKey }), {
        headers: JSON_CONTENT_TYPE
      });
    }
    
    // 处理 OpenAI API 转发
    if (url.pathname.startsWith('/v1/')) {
      if (url.pathname === '/v1/models') {
        return handleModels(request, env);
      }
      return handleChatCompletions(request, env);
    }
    
    // 处理管理员 API 端点 - 这些是前端 admin.html 使用的路径
    if (url.pathname === '/stats') {
      return getStats(env);
    } else if (url.pathname === '/logs') {
      return getLogs(request, env);
    } else if (url.pathname === '/import_keys' && request.method === 'POST') {
      return importApiKeys(request, env);
    } else if (url.pathname === '/export_keys') {
      return exportApiKeys(env);
    } else if (url.pathname === '/refresh' && request.method === 'POST') {
      return refreshApiKeys(env);
    } else if (url.pathname === '/clear_logs' && request.method === 'POST') {
      return clearLogs(env);
    }
    
    // 处理 API 请求
    if (url.pathname.startsWith('/api/')) {
      // 验证管理员会话
      const isAuthenticated = await validateSession(env, request);
      if (!isAuthenticated) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: JSON_CONTENT_TYPE
        });
      }
      
      // 处理各种管理员 API 端点
      if (url.pathname === '/api/stats') {
        return getStats(env);
      } else if (url.pathname === '/api/logs') {
        return getLogs(request, env);
      } else if (url.pathname === '/api/keys' && request.method === 'POST') {
        return importApiKeys(request, env);
      } else if (url.pathname.startsWith('/api/keys/') && request.method === 'DELETE') {
        const keyId = url.pathname.split('/').pop();
        return deleteApiKey(keyId, env);
      } else if (url.pathname === '/api/keys/export') {
        return exportApiKeys(env);
      } else if (url.pathname === '/api/keys/refresh') {
        return refreshApiKeys(env);
      } else if (url.pathname === '/api/logs/clear' && request.method === 'POST') {
        return clearLogs(env);
      }
      
      return new Response('API endpoint not found', { status: 404 });
    }
    
    // 处理管理员路由
    if (url.pathname.startsWith('/admin')) {
      // 验证管理员会话
      const isAuthenticated = await validateSession(env, request);
      if (!isAuthenticated && url.pathname !== '/admin/login') {
        return serveErrorPage(request, 401, env, ctx);
      }
    }
    
    // 处理静态资源
    try {
      // 检查是否是直接请求错误页面
      if (url.pathname === '/401.html' || url.pathname === '/404.html' || url.pathname === '/500.html') {
        const errorCode = parseInt(url.pathname.replace(/[^\d]/g, ''));
        return serveErrorPage(request, errorCode, env, ctx);
      }
      
      // 尝试从 KV 获取静态资源
      const options = {
        ASSET_NAMESPACE: env.STATIC_CONTENT,
        ASSET_MANIFEST: env.__STATIC_CONTENT_MANIFEST,
        // 添加自定义错误页面
        mapRequestToAsset: req => {
          const url = new URL(req.url);
          
          // 处理特定路径
          if (url.pathname === '/admin') {
            url.pathname = '/admin.html';
            return new Request(url.toString(), req);
          }
          
          if (url.pathname === '/') {
            url.pathname = '/index.html';
            return new Request(url.toString(), req);
          }
          
          return req;
        },
      };
      
      return await getAssetFromKV(
        {
          request,
          waitUntil: ctx.waitUntil.bind(ctx),
        },
        options
      );
    } catch (e) {
      console.error('Error serving static asset:', e.message);
      
      // 确定错误状态码
      let statusCode = 404;
      if (e.status === 500 || e.message.includes('internal') || e.message.includes('unexpected')) {
        statusCode = 500;
      } else if (e.status === 401 || e.message.includes('unauthorized') || e.message.includes('permission')) {
        statusCode = 401;
      } else if (e.status) {
        statusCode = e.status;
      }
      
      return serveErrorPage(request, statusCode, env, ctx);
    }
  }
};