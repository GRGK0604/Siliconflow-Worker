#!/bin/bash

# Silicon Pool Worker 发布脚本
# 此脚本会更新远程数据库、上传静态文件，然后部署 Worker 到 Cloudflare

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 打印带颜色的消息
print_message() {
  echo -e "${2}${1}${NC}"
}

# 打印步骤
print_step() {
  print_message "🚀 步骤 $1: $2" "${BLUE}"
}

# 打印成功消息
print_success() {
  print_message "✅ $1" "${GREEN}"
}

# 打印警告消息
print_warning() {
  print_message "⚠️  $1" "${YELLOW}"
}

# 打印错误消息
print_error() {
  print_message "❌ $1" "${RED}"
}

# 检查命令是否存在
check_command() {
  if ! command -v $1 &> /dev/null; then
    print_error "$1 命令未找到，请先安装。"
    exit 1
  fi
}

# 检查必要的命令
check_command wrangler
check_command git

# 确保工作目录是项目根目录
if [ ! -f "wrangler.toml" ]; then
  print_error "请在项目根目录运行此脚本。"
  exit 1
fi

# 获取当前分支
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
print_message "当前分支: ${CURRENT_BRANCH}" "${BLUE}"

# 确认发布
read -p "确定要发布 Silicon Pool Worker 到 Cloudflare 吗? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  print_message "发布已取消。" "${YELLOW}"
  exit 0
fi

# 步骤 1: 检查未提交的更改
print_step "1" "检查未提交的更改"
if [[ -n $(git status -s) ]]; then
  print_warning "存在未提交的更改:"
  git status -s
  read -p "是否继续发布? (y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    print_message "发布已取消。" "${YELLOW}"
    exit 0
  fi
else
  print_success "没有未提交的更改。"
fi

# 步骤 2: 上传静态文件到 KV 存储
print_step "2" "上传静态文件到 KV 存储"
./deploy-static.sh
if [ $? -eq 0 ]; then
  print_success "静态文件上传成功"
else
  print_error "静态文件上传失败"
  read -p "是否继续发布? (y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    print_message "发布已取消。" "${YELLOW}"
    exit 0
  fi
fi

# 步骤 3: 迁移远程数据库
print_step "3" "迁移远程数据库"
print_message "正在迁移远程数据库..." "${BLUE}"
wrangler d1 migrations apply silicon_key_pool
if [ $? -eq 0 ]; then
  print_success "数据库迁移成功"
else
  print_error "数据库迁移失败"
  read -p "是否继续发布? (y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    print_message "发布已取消。" "${YELLOW}"
    exit 0
  fi
fi

# 步骤 4: 部署 Worker 到 Cloudflare
print_step "4" "部署 Worker 到 Cloudflare"
print_message "正在部署 Worker..." "${BLUE}"
wrangler deploy
if [ $? -eq 0 ]; then
  print_success "Worker 部署成功"
else
  print_error "Worker 部署失败"
  exit 1
fi

# 步骤 5: 验证部署
print_step "5" "验证部署"
# 从 wrangler.toml 获取域名
DOMAIN=$(grep -o 'pattern = ".*"' wrangler.toml | sed 's/pattern = "\(.*\)"/\1/' || echo "未找到域名")

if [[ $DOMAIN != "未找到域名" ]]; then
  print_message "您可以通过访问以下地址验证部署:" "${BLUE}"
  print_message "https://$DOMAIN" "${GREEN}"
else
  print_warning "无法从 wrangler.toml 获取域名，请手动验证部署。"
fi

print_success "🎉 发布流程完成!"
print_message "如果您需要回滚，可以使用 'wrangler rollback' 命令。" "${BLUE}" 