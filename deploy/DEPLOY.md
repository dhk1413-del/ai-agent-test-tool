# 部署说明

## 架构

```
外网用户
   │  HTTPS（Cloudflare Tunnel / Tailscale Funnel / 自己的反代）
   ▼
nginx  127.0.0.1:8081
   │  ├─ 未登录 → 302 /login（登录页）
   │  └─ 已登录 → 校验通过后转发
   ▼
┌─────────────────────────────┐
│ ai-auth  127.0.0.1:8090     │  登录页 / 会话校验 / 退出
└─────────────────────────────┘
   │
   ▼
AI 智能体测试工具  127.0.0.1:3789（Docker 容器 ai-tester）
```

应用本身没有登录，所以入口统一走 nginx + ai-auth；`docker-compose.yml` 里应用端口只监听本机即可（或保持默认，由防火墙/安全组限制）。

## 前置条件

- Linux 服务器（Ubuntu 22.04+ / Debian 12+）
- Docker + Docker Compose v2
- nginx（`apt install nginx`）
- Python 3（登录服务只用标准库）

## 1. 启动应用

```bash
git clone <本仓库地址> ai-agent-test-tool
cd ai-agent-test-tool

docker compose up -d --build

# 确认服务正常
curl http://127.0.0.1:3789/api/health
```

- 测试数据保存在 `./data`（项目、轮次、截图、报告），请定期备份。
- 受控浏览器的登录态保存在 Docker 卷 `ai-tester-profile` 中；目标站点需要登录时，通过 noVNC 登录一次即可（见第 4 节）。
- `docker-compose.yml` 中 noVNC（7900）只绑定 `127.0.0.1`，**不要**改成 `0.0.0.0`。

## 2. 部署登录服务

```bash
sudo mkdir -p /opt/ai-auth
sudo cp auth/auth.py auth/login.html auth/set_password.py /opt/ai-auth/
cd /opt/ai-auth
sudo python3 set_password.py ai '设置一个强密码'

sudo cp /path/to/repo/deploy/ai-auth.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ai-auth

curl http://127.0.0.1:8090/healthz   # 返回 ok
```

> 修改密码：重新执行 `python3 set_password.py ai '新密码'`，然后 `systemctl restart ai-auth`。

## 3. 配置 nginx

```bash
sudo cp deploy/nginx-ai-tester.conf /etc/nginx/sites-available/ai-tester
sudo cp deploy/ai-tester-proxy.inc /etc/nginx/ai-tester-proxy.inc
sudo cp deploy/ai-tester-proto.conf /etc/nginx/conf.d/ai-tester-proto.conf

sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sf /etc/nginx/sites-available/ai-tester /etc/nginx/sites-enabled/ai-tester

sudo nginx -t && sudo systemctl reload nginx
```

验证：

```bash
curl -I http://127.0.0.1:8081/          # 302 → /login?next=/
curl -s http://127.0.0.1:8081/login | head   # 200，登录页 HTML
```

## 4. 打开外网入口（二选一）

### 方案 A：Cloudflare Tunnel（推荐，无需公网 IP）

```bash
docker run -d --name cf-tunnel --restart unless-stopped --net=host \
  cloudflare/cloudflared:latest tunnel --url http://127.0.0.1:8081 \
  --no-autoupdate --protocol http2

docker logs cf-tunnel 2>&1 | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1
```

- 免费快速隧道域名是随机的，**每次重启隧道会变**；正式使用建议在 Cloudflare 账号里建 named tunnel 并绑定自己的域名。
- nginx 配置里对带 `cf-ray` 头的 `/api/runs/*/events` 直接返回 503：因为 Cloudflare 会整段缓冲 SSE，前端收到错误后会自动降级为 3 秒轮询，测试进度仍会更新。
- 通过 Cloudflare 访问时 `X-Forwarded-Proto: https` 会让会话 Cookie 自动带 `Secure`。

### 方案 B：Tailscale Funnel

```bash
tailscale funnel --bg 8081
# 访问 https://<机器名>.<tailnet>.ts.net/
```

- 地址固定、免公网 IP，但跨境线路可能较慢，适合内部小范围使用。
- 如果目标站点需要登录，noVNC 可以只在 tailnet 内开放：

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:7900
# 访问 https://<机器名>.<tailnet>.ts.net:8443/vnc.html
```

## 5. 需要登录的目标站点

有些学校/单位的机器人地址会先跳到统一身份认证（CAS/SSO）。这种情况需要先在容器浏览器里登录一次：

1. 通过 SSH 隧道或 tailnet 打开 noVNC（见上）；
2. 在容器浏览器里输入账号密码完成登录，直到进入机器人聊天页；
3. 回到测试平台重新开始测试。

登录态会保存在 `ai-tester-profile` 卷里，容器重启后一般仍然有效（直到站点会话过期）。

## 6. 安全清单

- [ ] 应用端口 3789、noVNC 7900 不对公网开放，只由本机 nginx/隧道访问
- [ ] 全程 HTTPS（Cloudflare Tunnel / Tailscale Funnel / 自己的证书）
- [ ] 登录密码足够强，`/opt/ai-auth/users.json`、`secret` 权限 600
- [ ] 定期修改密码（`set_password.py` 会同时让旧会话失效）
- [ ] 备份 `./data` 目录
- [ ] 仅测试自己拥有或已获授权的 AI 问答系统，遵守目标站点的使用条款
