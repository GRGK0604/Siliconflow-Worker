#!/bin/bash

# 环境参数，默认为本地
ENV=${1:-"local"}

echo "正在部署静态文件到 $ENV 环境..."

# 获取static目录下所有文件
cd ./static
files=$(find . -type f -not -path "*/\.*" | sed 's|^\./||')
cd ..

# 遍历并上传所有静态文件
for file in $files; do
  echo "上传 $file..."
  if [ "$ENV" = "local" ]; then
    wrangler kv:key put --binding=STATIC_CONTENT "$file" --path="./static/$file" --local
  else
    wrangler kv:key put --binding=STATIC_CONTENT "$file" --path="./static/$file"
  fi
done

echo "静态文件部署完成！共同步了 $(echo "$files" | wc -l) 个文件" 