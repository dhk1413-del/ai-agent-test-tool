#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AI 测试平台 —— 登录会话服务

对外只提供:
  GET  /login        登录页
  POST /login        提交账号密码，成功写会话 Cookie 并跳转
  GET  /logout       清除会话
  GET  /_authcheck   nginx auth_request 内部校验（204/401）
"""
import base64
import hashlib
import hmac
import html
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

BASE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("AI_AUTH_PORT", "8090"))
COOKIE = "ai_sess"
TTL = 7 * 24 * 3600
MAX_FAILS = 8
FAIL_WINDOW = 300

with open(os.path.join(BASE, "secret"), "rb") as f:
    SECRET = f.read().strip()
with open(os.path.join(BASE, "users.json"), encoding="utf-8") as f:
    USERS = json.load(f)
with open(os.path.join(BASE, "login.html"), encoding="utf-8") as f:
    LOGIN_HTML = f.read()

fail_hits = {}


def b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def make_token(user: str) -> str:
    exp = int(time.time()) + TTL
    payload = f"{user}|{exp}".encode()
    sig = hmac.new(SECRET, payload, hashlib.sha256).digest()
    return b64e(payload) + "." + b64e(sig)


def verify_token(tok: str):
    try:
        p, s = tok.split(".", 1)
        payload, sig = b64d(p), b64d(s)
    except Exception:
        return None
    want = hmac.new(SECRET, payload, hashlib.sha256).digest()
    if not hmac.compare_digest(sig, want):
        return None
    try:
        user, exp = payload.decode().split("|", 1)
        exp = int(exp)
    except Exception:
        return None
    if exp < time.time() or user not in USERS:
        return None
    return user


def check_password(user: str, pw: str) -> bool:
    rec = USERS.get(user)
    if not rec:
        return False
    salt = bytes.fromhex(rec["salt"])
    it = int(rec.get("iter", 200000))
    calc = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, it).hex()
    return hmac.compare_digest(calc, rec["hash"])


def safe_next(raw: str) -> str:
    if not raw or not raw.startswith("/") or raw.startswith("//") or raw.startswith("/\\"):
        return "/"
    return raw


def render_login(error: str = "", next_path: str = "/", username: str = "") -> bytes:
    page = LOGIN_HTML
    page = page.replace("{{ERROR}}", html.escape(error))
    page = page.replace("{{ERROR_CLASS}}", "" if error else "hidden")
    page = page.replace("{{NEXT}}", html.escape(safe_next(next_path)))
    page = page.replace("{{USERNAME}}", html.escape(username or ""))
    return page.encode("utf-8")


def cookie_header(token: str, secure: bool, max_age: int = TTL) -> str:
    parts = [f"{COOKIE}={token}", "Path=/", "HttpOnly", "SameSite=Lax", f"Max-Age={max_age}"]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def rate_ok(ip: str) -> bool:
    now = time.time()
    hits = [t for t in fail_hits.get(ip, []) if now - t < FAIL_WINDOW]
    fail_hits[ip] = hits
    return len(hits) < MAX_FAILS


def record_fail(ip: str) -> None:
    fail_hits.setdefault(ip, []).append(time.time())


class Handler(BaseHTTPRequestHandler):
    server_version = "ai-auth/1.0"

    def log_message(self, fmt, *args):  # 安静一点
        pass

    # ---------- 工具 ----------
    def send(self, code, body=b"", ctype="text/html; charset=utf-8", headers=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in headers or []:
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def cookie_token(self):
        raw = self.headers.get("Cookie") or ""
        for part in raw.split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE:
                return v
        return None

    # ---------- 路由 ----------
    def do_GET(self):
        url = urlsplit(self.path)
        path = url.path
        if path == "/_authcheck":
            tok = self.cookie_token()
            if tok and verify_token(tok):
                return self.send(204)
            return self.send(401, ctype="text/plain")
        if path == "/healthz":
            return self.send(200, b"ok", ctype="text/plain")
        if path == "/logout":
            return self.send(302, headers=[
                ("Set-Cookie", f"{COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"),
                ("Location", "/login"),
            ])
        if path == "/login":
            q = parse_qs(url.query)
            nxt = safe_next((q.get("next") or ["/"])[0])
            tok = self.cookie_token()
            if tok and verify_token(tok):
                return self.send(302, headers=[("Location", nxt)])
            return self.send(200, render_login(next_path=nxt))
        return self.send(404, b"not found", ctype="text/plain")

    def do_HEAD(self):
        return self.do_GET()

    def do_POST(self):
        url = urlsplit(self.path)
        if url.path != "/login":
            return self.send(404, b"not found", ctype="text/plain")
        length = int(self.headers.get("Content-Length") or 0)
        if length > 10000:
            return self.send(413, ctype="text/plain")
        body = self.rfile.read(length).decode("utf-8", "replace")
        form = parse_qs(body)
        user = (form.get("username") or [""])[0].strip()
        pw = (form.get("password") or [""])[0]
        nxt = safe_next((form.get("next") or ["/"])[0])
        ip = self.headers.get("X-Real-IP") or self.client_address[0]

        if not rate_ok(ip):
            return self.send(429, render_login("尝试次数过多，请过几分钟再试", nxt, user))

        if check_password(user, pw) and rate_ok(ip):
            secure = (self.headers.get("X-Forwarded-Proto") or "") == "https"
            tok = make_token(user)
            return self.send(302, headers=[
                ("Set-Cookie", cookie_header(tok, secure)),
                ("Location", nxt),
            ])

        record_fail(ip)
        time.sleep(0.4)  # 稍微拖慢暴力尝试
        return self.send(200, render_login("用户名或密码不正确", nxt, user))


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"ai-auth listening on 127.0.0.1:{PORT}", flush=True)
    srv.serve_forever()
