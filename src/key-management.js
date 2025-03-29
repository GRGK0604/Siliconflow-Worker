// API 密钥管理相关功能

import { nanoid } from 'nanoid';

// 验证 API 密钥
export async function validateApiKey(apiKey) {
  try {
    const response = await fetch('https://api.siliconflow.cn/v1/user/info', {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      // 添加超时设置
      timeout: 10000
    });
    
    if (response.ok) {
      const data = await response.json();
      
      // 更安全的余额处理方式
      let balance = 0;
      if (data && data.data && data.data.totalBalance !== undefined) {
        // 确保 totalBalance 是数字
        const rawBalance = parseFloat(data.data.totalBalance);
        if (!isNaN(rawBalance)) {
          balance = parseFloat(rawBalance.toFixed(4));
        }
      }
      
      return {
        valid: true,
        balance: balance,
        model_access: data?.data?.modelAccess || [],
        user_info: data?.data?.userInfo || {}
      };
    }
    
    // 处理非 200 响应
    const errorData = await response.text();
    console.warn(`API key validation failed with status ${response.status}: ${errorData}`);
    
    return {
      valid: false,
      message: `Invalid API key (Status: ${response.status})`
    };
  } catch (error) {
    console.error('Error validating API key:', error);
    return {
      valid: false,
      message: `Validation error: ${error.message}`
    };
  }
}

// 导入 API 密钥 - 修改为分批导入
export async function importApiKeys(request, env) {
  try {
    const data = await request.json();
    const keys = data.keys || [];
    
    if (!Array.isArray(keys) || keys.length === 0) {
      return new Response(JSON.stringify({
        error: '未提供有效的密钥'  
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 分批导入密钥,每批最多20个
    const batchSize = 20;
    let totalImported = 0;
    let totalBalance = 0;
    let totalDuplicates = 0;
    let totalInvalid = 0;
    
    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);
      
      // 导入当前批次密钥并获取统计信息
      const importStats = await addKeysToDatabase(batch, env);
      totalImported += importStats.imported;
      totalBalance += importStats.totalBalance;
      totalDuplicates += importStats.duplicates;
      totalInvalid += importStats.invalid;
      
      // 将导入结果写入KV存储,防止中途失败
      await env.KV_IMPORT_RESULT.put(`import-${Date.now()}`, JSON.stringify(importStats));
    }
    
    // 获取更新后的统计信息
    const totalKeysCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM api_keys'
    ).first();
    
    const activeKeysCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM api_keys WHERE is_active = 1'
    ).first();
    
    const totalBalanceDB = await env.DB.prepare(
      'SELECT ROUND(SUM(balance), 4) as sum FROM api_keys WHERE is_active = 1'
    ).first();
    
    // 构建友好的消息
    let message = `处理了 ${keys.length} 个密钥,成功导入 ${totalImported} 个,新增余额 ${totalBalance.toFixed(4)} 元`;
    if (totalDuplicates > 0) {
      message += `，${totalDuplicates} 个已存在`;
    }
    if (totalInvalid > 0) {
      message += `，${totalInvalid} 个无效`;
    }
    
    return new Response(JSON.stringify({
      message: message,
      stats: {
        totalKeys: totalKeysCount.count || 0,
        activeKeys: activeKeysCount.count || 0,
        totalBalance: (parseFloat(totalBalanceDB.sum || 0) + totalBalance).toFixed(4)
      },
      importStats: {
        total: keys.length,
        imported: totalImported,
        duplicates: totalDuplicates,
        invalid: totalInvalid,
        totalBalance: totalBalance
      }
    }), {
      headers: { 'Content-Type': 'application/json' }  
    });
  } catch (error) {
    console.error('Error importing keys:', error);
    return new Response(JSON.stringify({
      error: `导入密钥失败: ${error.message}`
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 导出 API 密钥
export async function exportApiKeys(env) {
  try {
    const { results } = await env.DB.prepare(
      'SELECT * FROM api_keys'
    ).all();
    
    return new Response(JSON.stringify({
      keys: results || []
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: `导出密钥失败: ${error.message}`
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 刷新 API 密钥 - 修改为分批刷新
export async function refreshApiKeys(env) {
  try {
    // 获取所有密钥
    const { results } = await env.DB.prepare(
      'SELECT * FROM api_keys'
    ).all();
    
    if (!results || results.length === 0) {
      return new Response(JSON.stringify({
        message: '没有需要刷新的密钥'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 分批刷新密钥,每批最多20个
    const batchSize = 20;
    const refreshPromises = [];
    
    for (let i = 0; i < results.length; i += batchSize) {
      const batch = results.slice(i, i + batchSize);
      
      // 刷新当前批次的密钥
      const batchPromise = refreshKeysBatch(batch, env);
      refreshPromises.push(batchPromise);
    }
    
    // 等待所有批次刷新完成
    const refreshResults = await Promise.all(refreshPromises);
    
    // 将刷新结果写入KV存储
    if (env.KV_REFRESH_RESULT) {
      await env.KV_REFRESH_RESULT.put(`refresh-${Date.now()}`, JSON.stringify(refreshResults));
    }
    
    // 获取更新后的统计信息
    const totalKeysCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM api_keys'
    ).first();
    
    const activeKeysCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM api_keys WHERE is_active = 1'
    ).first();
    
    const totalBalance = await env.DB.prepare(
      'SELECT ROUND(SUM(balance), 4) as sum FROM api_keys WHERE is_active = 1'
    ).first();
    
    return new Response(JSON.stringify({
      message: '密钥刷新成功',
      results: refreshResults,
      stats: {
        totalKeys: totalKeysCount.count || 0,
        activeKeys: activeKeysCount.count || 0,
        totalBalance: parseFloat(totalBalance.sum || 0).toFixed(4)
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error refreshing API keys:', error);
    return new Response(JSON.stringify({
      error: `刷新密钥失败: ${error.message}` 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 刷新一批密钥
async function refreshKeysBatch(batch, env) {
  const validationResults = await Promise.all(batch.map(async (keyData) => {
    try {
      const validation = await validateApiKey(keyData.key);
      
      // 更新密钥状态和余额
      await env.DB.prepare(
        'UPDATE api_keys SET is_active = ?, balance = ?, last_check_time = ? WHERE id = ?'
      ).bind(validation.valid ? 1 : 0, validation.balance || 0, Date.now(), keyData.id).run();
      
      return { key: keyData.key, valid: validation.valid, balance: validation.balance };
    } catch (error) {
      console.error(`Error validating key ${keyData.key}:`, error);
      return { key: keyData.key, valid: false, error: error.message };  
    }
  }));
  
  return validationResults;
}

// 添加密钥到数据库 - 修改为分批写入
async function addKeysToDatabase(keys, env) {
  // 初始化统计信息
  const stats = {
    total: keys.length,
    imported: 0,
    duplicates: 0,
    invalid: 0,
    totalBalance: 0
  };
  
  // 先验证所有密钥
  const validationResults = await Promise.all(
    keys.map(async (key) => {
      try {
        const validation = await validateApiKey(key);
        return {
          key,
          valid: validation.valid,
          balance: validation.balance || 0,
          model_access: JSON.stringify(validation.model_access || [])
        };
      } catch (error) {
        console.error(`Error validating key ${key}:`, error);
        return { key, valid: false, balance: 0, model_access: '[]' };
      }
    })
  );
  
  // 检查数据库中已存在的密钥
  const allKeys = keys.join("','");
  const { results: existingKeys } = await env.DB.prepare(
    `SELECT key FROM api_keys WHERE key IN ('${allKeys}')`
  ).all();
  
  const existingKeySet = new Set(existingKeys.map(row => row.key));
  
  // 过滤出有效且不重复的密钥
  const keysToInsert = validationResults.filter(result => 
    result.valid && !existingKeySet.has(result.key)
  );
  
  // 计算统计信息
  stats.duplicates = existingKeySet.size;
  stats.invalid = validationResults.filter(result => !result.valid).length;
  
  // 分批写入数据库
  const batchSize = 50;
  
  for (let i = 0; i < keysToInsert.length; i += batchSize) {
    const batch = keysToInsert.slice(i, i + batchSize);
    
    if (batch.length === 0) continue;
    
    // 构建批量插入的SQL
    const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const values = batch.map(result => [
      nanoid(),
      result.key, 
      Date.now(),
      Date.now(), 
      Date.now(),
      result.balance,
      1,
      result.model_access
    ]).flat();
    
    try {
      // 批量插入当前批次的密钥
      await env.DB.prepare(
        `INSERT INTO api_keys (id, key, created_at, add_time, last_check_time, balance, is_active, model_access) VALUES ${placeholders}`  
      ).bind(...values).run();
      
      stats.imported += batch.length;
      stats.totalBalance += batch.reduce((sum, result) => sum + result.balance, 0);
    } catch (error) {
      console.error(`Error importing batch ${i}-${i+batchSize}:`, error);
      // 这里不增加 invalid 计数，因为我们已经在前面计算过了
    }
  }
  
  return stats;
}

// 验证 API 密钥
export async function validateKey(apiKey, env) {
  const baseUrl = env.BASE_URL || "https://api.siliconflow.cn";
  const headers = { "Authorization": `Bearer ${apiKey}` };
  try {
    const response = await fetch(`${baseUrl}/v1/user/info`, {
      headers,
      method: "GET",
      timeout: 10000
    });
    
    if (response.status === 200) {
      const data = await response.json();
      
      // 更安全的余额处理方式
      let balance = 0;
      if (data && data.data && data.data.totalBalance !== undefined) {
        // 确保 totalBalance 是数字
        const rawBalance = parseFloat(data.data.totalBalance);
        if (!isNaN(rawBalance)) {
          balance = parseFloat(rawBalance.toFixed(4));
        }
      }
      
      return { valid: true, balance: balance };
    } else {
      let errorMessage = "验证失败";
      try {
        const data = await response.json();
        errorMessage = data?.message || errorMessage;
      } catch (e) {
        // 如果响应不是JSON格式，使用默认错误消息
      }
      return { valid: false, message: errorMessage };
    }
  } catch (error) {
    return { valid: false, message: `请求失败: ${error.message}` };
  }
}

// 获取所有 API 密钥详情
export async function getApiKeysDetails(env) {
  try {
    // 从数据库获取所有密钥详情
    const { results } = await env.DB.prepare(
      `SELECT id, key, created_at, add_time, last_used_at, last_check_time, 
       balance, is_active, usage_count, model_access 
       FROM api_keys ORDER BY balance DESC`
    ).all();
    
    if (!results || results.length === 0) {
      return new Response(JSON.stringify({
        keys: []
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 处理结果，格式化日期和其他字段
    const formattedKeys = results.map(key => {
      return {
        id: key.id,
        key: key.key,
        created_at: key.created_at,
        add_time: key.add_time,
        last_used_at: key.last_used_at || null,
        last_check_time: key.last_check_time || null,
        balance: key.balance || 0,
        is_active: key.is_active === 1,
        usage_count: key.usage_count || 0,
        model_access: key.model_access ? JSON.parse(key.model_access) : []
      };
    });
    
    return new Response(JSON.stringify({
      keys: formattedKeys
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error fetching API keys details:', error);
    return new Response(JSON.stringify({
      error: `获取密钥详情失败: ${error.message}`
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 刷新单个 API Key
export async function refreshSingleApiKey(request, env) {
  try {
    // 从 URL 路径中获取 key ID
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/');
    const keyId = pathParts[pathParts.length - 1];
    
    if (!keyId) {
      return new Response(JSON.stringify({
        success: false,
        message: '未提供有效的密钥 ID'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 获取密钥信息
    const keyData = await env.DB.prepare(
      'SELECT * FROM api_keys WHERE id = ?'
    ).bind(keyId).first();
    
    if (!keyData) {
      return new Response(JSON.stringify({
        success: false,
        message: '未找到指定的密钥'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 验证密钥
    const validation = await validateApiKey(keyData.key);
    
    // 更新密钥状态和余额
    await env.DB.prepare(
      'UPDATE api_keys SET is_active = ?, balance = ?, last_check_time = ? WHERE id = ?'
    ).bind(validation.valid ? 1 : 0, validation.balance || 0, Date.now(), keyId).run();
    
    // 获取更新后的密钥信息
    const updatedKey = await env.DB.prepare(
      'SELECT * FROM api_keys WHERE id = ?'
    ).bind(keyId).first();
    
    // 格式化返回数据
    const formattedKey = {
      id: updatedKey.id,
      key: updatedKey.key,
      balance: updatedKey.balance || 0,
      is_active: updatedKey.is_active === 1,
      last_check_time: updatedKey.last_check_time,
      usage_count: updatedKey.usage_count || 0,
      last_used_at: updatedKey.last_used_at || null,
      add_time: updatedKey.add_time
    };
    
    return new Response(JSON.stringify({
      success: true,
      message: '密钥刷新成功',
      key: formattedKey
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error refreshing single API key:', error);
    return new Response(JSON.stringify({
      success: false,
      message: `刷新密钥失败: ${error.message}`
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 批量刷新选中的 API Keys - 修改为分批处理
export async function refreshBatchApiKeys(request, env) {
  try {
    const data = await request.json();
    const keyIds = data.key_ids || [];
    
    if (!Array.isArray(keyIds) || keyIds.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        message: '未提供有效的密钥 ID 列表'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 获取所有密钥信息
    const placeholders = keyIds.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT * FROM api_keys WHERE id IN (${placeholders})`
    ).bind(...keyIds).all();
    
    if (!results || results.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        message: '未找到指定的密钥'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 分批处理密钥验证
    const batchSize = 5; // 每批处理的密钥数量
    const delay = 1000; // 批次间延迟(毫秒)
    const refreshedKeys = [];
    
    // 分批处理
    for (let i = 0; i < results.length; i += batchSize) {
      const batch = results.slice(i, i + batchSize);
      
      // 处理当前批次
      const batchPromises = batch.map(async (keyData) => {
        try {
          const validation = await validateApiKey(keyData.key);
          
          // 更新密钥状态和余额
          await env.DB.prepare(
            'UPDATE api_keys SET is_active = ?, balance = ?, last_check_time = ? WHERE id = ?'
          ).bind(validation.valid ? 1 : 0, validation.balance || 0, Date.now(), keyData.id).run();
          
          // 获取更新后的密钥信息
          const updatedKey = await env.DB.prepare(
            'SELECT * FROM api_keys WHERE id = ?'
          ).bind(keyData.id).first();
          
          return {
            id: updatedKey.id,
            key: updatedKey.key,
            balance: updatedKey.balance || 0,
            is_active: updatedKey.is_active === 1,
            last_check_time: updatedKey.last_check_time,
            usage_count: updatedKey.usage_count || 0,
            last_used_at: updatedKey.last_used_at || null,
            add_time: updatedKey.add_time
          };
        } catch (error) {
          console.error(`Error refreshing key ${keyData.id}:`, error);
          return {
            id: keyData.id,
            error: error.message
          };
        }
      });
      
      // 等待当前批次完成
      const batchResults = await Promise.all(batchPromises);
      refreshedKeys.push(...batchResults);
      
      // 如果不是最后一批，添加延迟
      if (i + batchSize < results.length) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    return new Response(JSON.stringify({
      success: true,
      message: `成功刷新 ${refreshedKeys.length} 个密钥`,
      keys: refreshedKeys
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error refreshing batch API keys:', error);
    return new Response(JSON.stringify({
      success: false,
      message: `批量刷新密钥失败: ${error.message}`
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 刷新所有 API Keys - 修改为分批处理
export async function refreshAllKeys(env) {
  try {
    // 获取所有密钥
    const { results } = await env.DB.prepare(
      'SELECT * FROM api_keys'
    ).all();
    
    if (!results || results.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        message: '没有需要刷新的密钥'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 启动后台任务处理刷新
    const ctx = self || globalThis;
    ctx.setTimeout = ctx.setTimeout || setTimeout;
    
    // 使用 setTimeout 在后台处理，立即返回响应
    ctx.setTimeout(async () => {
      try {
        // 分批处理
        const batchSize = 5;
        const delay = 1000;
        
        for (let i = 0; i < results.length; i += batchSize) {
          const batch = results.slice(i, i + batchSize);
          
          // 处理当前批次
          await Promise.all(batch.map(async (keyData) => {
            try {
              const validation = await validateApiKey(keyData.key);
              
              // 更新密钥状态和余额
              await env.DB.prepare(
                'UPDATE api_keys SET is_active = ?, balance = ?, last_check_time = ? WHERE id = ?'
              ).bind(validation.valid ? 1 : 0, validation.balance || 0, Date.now(), keyData.id).run();
              
              return { id: keyData.id, success: true };
            } catch (error) {
              console.error(`Error refreshing key ${keyData.id}:`, error);
              return { id: keyData.id, success: false, error: error.message };
            }
          }));
          
          // 如果不是最后一批，添加延迟
          if (i + batchSize < results.length) {
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
        
        console.log(`Background refresh completed for ${results.length} keys`);
      } catch (error) {
        console.error('Error in background refresh of all keys:', error);
      }
    }, 0);
    
    return new Response(JSON.stringify({
      success: true,
      message: `已启动刷新 ${results.length} 个密钥的过程，请稍后查看结果`,
      total: results.length
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error refreshing all API keys:', error);
    return new Response(JSON.stringify({
      success: false,
      message: `刷新所有密钥失败: ${error.message}`
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 更新单个 API Key 状态
export async function updateApiKeyStatus(request, env) {
  try {
    // 从 URL 路径中获取 key ID
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/');
    const keyId = pathParts[pathParts.length - 1];
    
    const data = await request.json();
    const isActive = data.is_active;
    
    if (!keyId) {
      return new Response(JSON.stringify({
        success: false,
        message: '未提供有效的密钥 ID'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 检查密钥是否存在
    const keyExists = await env.DB.prepare(
      'SELECT id FROM api_keys WHERE id = ?'
    ).bind(keyId).first();
    
    if (!keyExists) {
      return new Response(JSON.stringify({
        success: false,
        message: '未找到指定的密钥'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 更新密钥状态
    await env.DB.prepare(
      'UPDATE api_keys SET is_active = ? WHERE id = ?'
    ).bind(isActive ? 1 : 0, keyId).run();
    
    return new Response(JSON.stringify({
      success: true,
      message: `密钥状态已更新为 ${isActive ? '启用' : '禁用'}`,
      id: keyId,
      is_active: isActive
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error updating API key status:', error);
    return new Response(JSON.stringify({
      success: false,
      message: `更新密钥状态失败: ${error.message}`
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 批量更新 API Keys 状态
export async function updateKeysStatus(request, env) {
  try {
    const data = await request.json();
    const keyIds = data.key_ids || [];
    const isActive = data.is_active;
    
    if (!Array.isArray(keyIds) || keyIds.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        message: '未提供有效的密钥 ID 列表'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 获取所有密钥信息
    const placeholders = keyIds.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT id FROM api_keys WHERE id IN (${placeholders})`
    ).bind(...keyIds).all();
    
    if (!results || results.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        message: '未找到指定的密钥'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 批量更新密钥状态
    const updatePromises = results.map(async (keyData) => {
      try {
        await env.DB.prepare(
          'UPDATE api_keys SET is_active = ? WHERE id = ?'
        ).bind(isActive ? 1 : 0, keyData.id).run();
        
        return { id: keyData.id, success: true };
      } catch (error) {
        console.error(`Error updating key ${keyData.id} status:`, error);
        return { id: keyData.id, success: false, error: error.message };
      }
    });
    
    await Promise.all(updatePromises);
    
    return new Response(JSON.stringify({
      success: true,
      message: `已成功${isActive ? '启用' : '禁用'} ${results.length} 个密钥`,
      updated_count: results.length
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error updating batch API keys status:', error);
    return new Response(JSON.stringify({
      success: false,
      message: `批量更新密钥状态失败: ${error.message}`
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 删除所有零余额的密钥 - 处理外键约束
export async function deleteZeroBalanceKeys(env) {
  try {
    // 首先获取所有零余额的密钥 ID
    const { results } = await env.DB.prepare(
      'SELECT id FROM api_keys WHERE balance <= 0'
    ).all();
    
    if (!results || results.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: '没有零余额密钥需要删除',
        deleted_count: 0
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 提取所有 ID
    const allIds = results.map(row => row.id);
    const totalCount = allIds.length;
    
    // 分批处理删除
    const batchSize = 100; // 每批处理的最大数量
    let deletedCount = 0;
    
    for (let i = 0; i < allIds.length; i += batchSize) {
      const batchIds = allIds.slice(i, i + batchSize);
      
      // 为当前批次创建参数占位符
      const placeholders = batchIds.map(() => '?').join(',');
      
      // 1. 首先删除相关的日志记录
      try {
        await env.DB.prepare(
          `DELETE FROM logs WHERE api_key_id IN (${placeholders})`
        ).bind(...batchIds).run();
      } catch (logError) {
        console.warn(`Warning: Error deleting logs for keys: ${logError.message}`);
        // 继续执行，即使日志删除失败
      }
      
      // 2. 然后删除密钥
      const result = await env.DB.prepare(
        `DELETE FROM api_keys WHERE id IN (${placeholders})`
      ).bind(...batchIds).run();
      
      deletedCount += result.meta?.changes || 0;
    }
    
    return new Response(JSON.stringify({
      success: true,
      message: `成功删除了 ${deletedCount} 个零余额密钥`,
      deleted_count: deletedCount
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error deleting zero balance keys:', error);
    return new Response(JSON.stringify({
      success: false,
      message: `删除零余额密钥失败: ${error.message}`
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 添加定时刷新机制
export async function scheduledRefresh(env) {
  console.log('Starting scheduled API key refresh');
  
  try {
    // 获取所有密钥
    const { results } = await env.DB.prepare(
      'SELECT * FROM api_keys'
    ).all();
    
    if (!results || results.length === 0) {
      console.log('No keys to refresh');
      return;
    }
    
    console.log(`Found ${results.length} keys to refresh`);
    
    // 分批刷新密钥,每批最多10个
    const batchSize = 10;
    const delay = 2000; // 批次间延迟(毫秒)
    let refreshedCount = 0;
    let activeCount = 0;
    let totalBalance = 0;
    
    for (let i = 0; i < results.length; i += batchSize) {
      const batch = results.slice(i, i + batchSize);
      
      // 处理当前批次
      const batchPromises = batch.map(async (keyData) => {
        try {
          const validation = await validateApiKey(keyData.key);
          
          // 更新密钥状态和余额
          await env.DB.prepare(
            'UPDATE api_keys SET is_active = ?, balance = ?, last_check_time = ? WHERE id = ?'
          ).bind(validation.valid ? 1 : 0, validation.balance || 0, Date.now(), keyData.id).run();
          
          if (validation.valid) {
            activeCount++;
            totalBalance += validation.balance || 0;
          }
          
          refreshedCount++;
          return { id: keyData.id, success: true, valid: validation.valid };
        } catch (error) {
          console.error(`Error refreshing key ${keyData.id}:`, error);
          return { id: keyData.id, success: false, error: error.message };
        }
      });
      
      await Promise.all(batchPromises);
      
      // 如果不是最后一批，添加延迟
      if (i + batchSize < results.length) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    // 将刷新结果写入KV存储
    const refreshResult = {
      timestamp: Date.now(),
      total: results.length,
      refreshed: refreshedCount,
      active: activeCount,
      totalBalance: totalBalance.toFixed(4)
    };
    
    await env.KV_REFRESH_RESULT.put(`scheduled-refresh-${new Date().toISOString().split('T')[0]}`, JSON.stringify(refreshResult));
    
    console.log(`Scheduled refresh completed: ${refreshedCount}/${results.length} keys processed, ${activeCount} active, total balance: ${totalBalance.toFixed(4)}`);
  } catch (error) {
    console.error('Error in scheduled refresh:', error);
  }
}