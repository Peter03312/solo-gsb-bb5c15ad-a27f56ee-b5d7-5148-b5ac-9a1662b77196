# 运行 Node.js 20 (Debian slim)，better-sqlite3 需编译工具链用于无预编译包的平台
FROM node:20-bookworm-slim

# better-sqlite3 安装时如无预编译二进制则从源码编译
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先拷贝依赖清单，利用 Docker 层缓存
COPY package.json ./
RUN npm install --omit=dev

# 拷贝应用源码
COPY . .

# 数据目录（SQLite 文件与 WAL 文件），由 compose 挂载为命名卷
RUN mkdir -p /data
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/interlock.db
ENV SEED_DEMO=1

EXPOSE 3000

# 容器启动即建表 + 初始化数据，然后启动 HTTP 服务
CMD ["sh", "-c", "node scripts/init-db.js && node src/server.js"]
