# 登录服务（ai-auth）

给 AI 智能体测试工具加一层登录，避免把内部测试平台直接暴露到公网。

- 登录页：`/login`（自带样式，支持手机端）
- 会话：HMAC-SHA256 签名的 Cookie，`HttpOnly`、`SameSite=Lax`、HTTPS 下自动加 `Secure`，有效期 7 天
- 密码：PBKDF2-SHA256（200000 轮）加盐存储，不保存明文
- 退出：访问 `/logout`
- 防爆破：同一 IP 5 分钟内连续失败 8 次即限流

## 文件

| 文件 | 说明 |
|---|---|
| `auth.py` | 登录服务，监听 `127.0.0.1:8090`（仅本机，由 nginx 反代） |
| `login.html` | 登录页模板（`{{ERROR}}`、`{{ERROR_CLASS}}`、`{{NEXT}}`、`{{USERNAME}}` 为占位符） |
| `set_password.py` | 设置账号密码，并轮换签名密钥（旧会话全部失效） |
| `users.json` | 账号密码哈希，首次运行 `set_password.py` 后自动生成（不要提交到仓库） |
| `secret` | 会话签名密钥，自动生成（不要提交到仓库） |

## 使用

```bash
cd /opt/ai-auth
cp /path/to/repo/auth/auth.py /path/to/repo/auth/login.html /path/to/repo/auth/set_password.py .
python3 set_password.py ai '你的强密码'
```

systemd 托管（模板见 `../deploy/ai-auth.service`）：

```bash
sudo cp deploy/ai-auth.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ai-auth
```

## 接口（仅供 nginx 内部调用）

| 路径 | 说明 |
|---|---|
| `GET /login` | 登录页；已登录则跳转 |
| `POST /login` | 提交账号密码，成功写 Cookie 并 302 |
| `GET /logout` | 清除会话 |
| `GET /_authcheck` | nginx `auth_request` 校验：已登录 204，未登录 401 |
| `GET /healthz` | 存活检查 |

## 安全提醒

- 不要把 `users.json`、`secret` 提交到 Git。
- 登录服务只监听 `127.0.0.1`，公网入口统一由 nginx 反向代理。
- 请务必通过 HTTPS（Cloudflare Tunnel / Tailscale Funnel / 证书反代）访问，否则 Cookie 会以明文传输。
