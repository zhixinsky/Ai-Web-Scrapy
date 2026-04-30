# better-sqlite3 需在 Linux 镜像内编译/安装
# 构建上下文须为仓库根目录，见 docker-compose 中 api.build.context
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY server/src ./src
# 业务代码在 src/export；空模板等运行时写入 uploads/（见 docker-compose 卷）
# 置于 WORKDIR 下 server/chrome-extension，与 resolveChromeExtensionSourceDir 首候选一致（避免仅打到 /workspace 根目录时漏拷贝）
COPY chrome-extension ./chrome-extension

ENV NODE_ENV=production
ENV PORT=3780
EXPOSE 3780

CMD ["node", "src/index.js"]
