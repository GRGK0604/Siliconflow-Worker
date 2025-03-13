// 管理员界面相关功能

import { nanoid } from 'nanoid';

// 导入所需函数
import { createSession } from './index.js';
import { getCookieValue } from './index.js';

// 处理管理员登录
export async function handleAdminLogin(request, env) {
  try {
    const { username, password } = await request.json();
    
    if (username === env.ADMIN_USERNAME && password === env.ADMIN_PASSWORD) {
      // 创建新会话
      const sessionId = await createSession(env, username);
      
      return new Response(JSON.stringify({
        success: true,
        message: '登录成功'
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': `session=${sessionId}; Path=/; HttpOnly; SameSite=Strict`
        }
      });
    }
    
    return new Response(JSON.stringify({
      success: false,
      error: '用户名或密码错误'
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Login error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: '登录失败'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 获取统计信息
export async function getStats(env) {
  try {
    // 获取 API 密钥数量
    const keysCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM api_keys'
    ).first();
    
    // 获取活跃 API 密钥数量
    const activeKeysCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM api_keys WHERE is_active = 1'
    ).first();
    
    // 获取请求总数
    const requestsCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM logs'
    ).first();
    
    // 检查 logs 表是否有 total_tokens 列
    const hasTokensColumn = await checkIfColumnExists(env, 'logs', 'total_tokens');
    
    let totalTokens = { sum: 0 };
    if (hasTokensColumn) {
      totalTokens = await env.DB.prepare(
        'SELECT SUM(total_tokens) as sum FROM logs'
      ).first();
    }
    
    // 获取总余额 - 使用固定格式的字符串表示
    const totalBalance = await env.DB.prepare(
      'SELECT SUM(balance) as sum FROM api_keys WHERE is_active = 1'
    ).first();
    
    return new Response(JSON.stringify({
      totalKeys: keysCount.count || 0,
      activeKeys: activeKeysCount.count || 0,
      totalRequests: requestsCount.count || 0,
      totalTokens: totalTokens.sum || 0,
      // 确保返回的是格式化为 4 位小数的字符串
      totalBalance: parseFloat(totalBalance.sum || 0).toFixed(4)
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    return new Response(JSON.stringify({
      error: 'Failed to get stats',
      message: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 辅助函数：检查表中是否存在特定列
async function checkIfColumnExists(env, tableName, columnName) {
  try {
    const result = await env.DB.prepare(
      `PRAGMA table_info(${tableName})`
    ).all();
    
    if (result && result.results) {
      return result.results.some(column => column.name === columnName);
    }
    return false;
  } catch (error) {
    console.error(`Error checking if column ${columnName} exists:`, error);
    return false;
  }
}

// 获取日志
export async function getLogs(request, env) {
  try {
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page') || '1');
    const pageSize = parseInt(url.searchParams.get('limit') || '20');
    const offset = (page - 1) * pageSize;
    
    // 获取日志总数
    const totalCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM logs'
    ).first();
    
    // 获取分页日志
    const logsQuery = await env.DB.prepare(
      `SELECT l.*, a.key as used_key 
       FROM logs l
       LEFT JOIN api_keys a ON l.api_key_id = a.id
       ORDER BY l.timestamp DESC
       LIMIT ? OFFSET ?`
    ).bind(pageSize, offset).all();
    
    // 格式化日志数据
    const logs = logsQuery.results.map(log => ({
      used_key: log.used_key || '',
      model: log.model || '',
      call_time: Math.floor(log.timestamp / 1000), // 转换为秒
      input_tokens: log.input_tokens || 0,
      output_tokens: log.output_tokens || 0,
      total_tokens: log.total_tokens || 0
    }));
    
    return new Response(JSON.stringify({
      logs,
      total: totalCount.count || 0,
      page,
      page_size: pageSize
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error getting logs:', error);
    return new Response(JSON.stringify({
      error: 'Failed to get logs',
      message: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 处理管理员退出
export async function handleAdminLogout(request, env) {
  const cookies = request.headers.get("Cookie");
  const sessionId = getCookieValue(cookies, "session");

  if (sessionId) {
    // 从数据库中删除会话
    try {
      await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
    } catch (error) {
      console.error('Error deleting session:', error);
    }
  }

  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': `session=; Path=/; HttpOnly; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
    }
  });
}

// 清空日志
export async function clearLogs(env) {
  try {
    await env.DB.prepare('DELETE FROM logs').run();
    
    return new Response(JSON.stringify({
      message: 'Logs cleared successfully'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error clearing logs:', error);
    return new Response(JSON.stringify({
      error: 'Failed to clear logs'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}