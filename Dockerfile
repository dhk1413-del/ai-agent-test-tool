# ---------------------------------------------------------------
# AI 问答测试平台 - Docker 镜像
# 基础镜像: Node 22 + Debian trixie (自带 chromium 154, 与 puppeteer-core 25 匹配)
# 图形方案: Xvfb 虚拟显示 + x11vnc + noVNC, 让你能在浏览器里看到并操作容器中的 Chrome
#          (首次登录超星必须在容器内的浏览器里做)
# ---------------------------------------------------------------
FROM node:22-trixie-slim

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai \
    NODE_ENV=production \
    LANG=C.UTF-8

# chromium: 受控浏览器本体
# fonts-noto-cjk / emoji: 保证截图和报告里的中文、表情符号不是方块
# xvfb/x11vnc/novnc/websockify: 虚拟显示 + 网页版 VNC
# tini: 正确转发信号, 避免 node 收不到 SIGTERM
RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-noto-cjk \
        fonts-noto-color-emoji \
        fonts-liberation \
        ca-certificates \
        tzdata \
        curl \
        procps \
        xvfb \
        x11vnc \
        novnc \
        websockify \
        tini \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f >/dev/null 2>&1 || true

WORKDIR /app

# 依赖层: 先装依赖, 改业务代码时不必重装
COPY package.json package-lock.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# 业务代码
COPY . .

RUN chmod +x /app/docker/entrypoint.sh \
    && mkdir -p /app/data /app/chrome-profile

# 3789: 网页界面   7900: noVNC(看容器里的浏览器)
EXPOSE 3789 7900

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3789/ >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
