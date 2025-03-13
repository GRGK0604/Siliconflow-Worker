# 安装与设置

## 前提条件

- [Node.js](https://nodejs.org/) (v16 或更高版本)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (v2 或更高版本)
- Cloudflare 账户

## 安装步骤

1. 克隆仓库：
   ```bash
   cd silicon-pool-worker
   ```

2. 安装依赖：
   ```bash
   npm install
   ```

3. 登录到 Cloudflare：
   ```bash
   wrangler login
   ```

4. 创建 D1 数据库：
   ```bash
   wrangler d1 create silicon_key_pool
   ```

5. 创建 KV 命名空间（用于存储静态资源）：
   ```bash
   # 创建 KV 命名空间
   wrangler kv:namespace create STATIC_CONTENT
   
   # 命令会返回类似以下内容：
   # [[kv_namespaces]]
   # binding = "STATIC_CONTENT"
   # id = "your-namespace-id"
   ```

6. 更新 `wrangler.toml` 配置：
   > 请将 wrangler.example.toml 文件重命名为 wrangler.toml 并进行配置
   ```toml
   name = "silicon-key-pool"
   main = "src/index.js"
   compatibility_date = "2023-12-01"

   # KV 命名空间配置
   [[kv_namespaces]]
   binding = "STATIC_CONTENT"
   id = "your-namespace-id"  # 替换为您的 KV 命名空间 ID

   # D1 数据库配置
   [[d1_databases]]
   binding = "DB"
   database_name = "silicon_key_pool"
   database_id = "your-d1-database-id"  # 替换为您的 D1 数据库 ID

   # 环境变量
   [vars]
   ADMIN_USERNAME = "admin"  # 更改为安全的用户名
   ADMIN_PASSWORD = "password"  # 更改为安全的密码
   API_KEY = ""  # 可选，用于保护 API 端点
   BASE_URL = "https://api.siliconflow.cn"
   ```

7. 上传静态资源到 KV：
   ```bash
   # 使用部署脚本上传所有静态资源
   ./deploy-static.sh
   
   # 如果需要部署到本地环境进行测试
   ./deploy-static.sh local
   ```

8. 创建数据库表：
   ```bash
   # 更新远程数据库
   wrangler d1 execute silicon_key_pool --file=./migrations/schema.sql --remote
   ```

9. 部署 Worker：
   ```bash
   # 使用部署脚本进行完整部署
   npm run deploy
   ```

## 验证部署

部署完成后：

1. 访问您的 Worker URL（例如 `https://your-worker.your-subdomain.workers.dev`）
2. 使用配置的管理员凭据登录
3. 验证所有功能是否正常工作

# 重要说明

## 关于静态资源管理

本项目使用 Cloudflare KV 存储来管理静态资源。静态资源包括：

- 页面文件：
  - index.html (登录页面)
  - admin.html (管理页面)
  - keys.html (密钥管理页面)
  
- 错误页面：
  - 401.html (未授权访问)
  - 404.html (页面未找到)
  - 500.html (服务器错误)
  
- 其他资源：
  - favicon.svg (网站图标)

您可以使用以下方式管理这些资源：

1. **使用部署脚本（推荐）**：
   ```bash
   # 部署所有静态资源到生产环境
   ./deploy-static.sh
   
   # 部署到本地环境进行测试
   ./deploy-static.sh local
   ```

2. **手动管理单个文件**：
   ```bash
   # 上传单个文件
   wrangler kv:key put --binding=STATIC_CONTENT "index.html" --path=./static/index.html
   
   # 查看已上传的文件
   wrangler kv:key list --binding=STATIC_CONTENT
   
   # 删除文件
   wrangler kv:key delete --binding=STATIC_CONTENT "index.html"
   ```

## 本地开发

1. 创建本地 D1 数据库：
   ```bash
   wrangler d1 create silicon_key_pool --local
   wrangler d1 execute silicon_key_pool --file=./migrations/schema.sql --local
   ```

2. 创建本地 KV 命名空间并上传静态资源：
   ```bash
   # 创建本地 KV 命名空间
   wrangler kv:namespace create STATIC_CONTENT --local
   
   # 上传静态资源到本地环境
   ./deploy-static.sh local
   ```

3. 启动本地开发服务器：
   ```bash
   wrangler dev --local
   ```

## 常见问题

1. **静态资源上传失败**
   - 检查 KV 命名空间 ID 是否正确配置
   - 确保文件存在于 static 目录中
   - 检查 Wrangler 是否已正确登录

2. **数据库迁移失败**
   - 确保 D1 数据库 ID 正确配置
   - 检查 SQL 文件语法是否正确
   - 验证数据库权限

3. **部署失败**
   - 检查 Cloudflare 账户权限
   - 确认所有配置参数正确
   - 查看错误日志进行排查