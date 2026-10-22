#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""设置登录账号密码，并让所有已登录会话失效。

用法：
    python3 set_password.py <用户名> <密码>

依赖：无（Python 3 标准库）
"""
import hashlib
import json
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
USERS = os.path.join(BASE, "users.json")
SECRET = os.path.join(BASE, "secret")
ITER = 200000


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    user, pw = sys.argv[1].strip(), sys.argv[2]
    if not user or len(pw) < 6:
        print("用户名不能为空，密码至少 6 位")
        return 2

    users = {}
    if os.path.exists(USERS):
        with open(USERS, encoding="utf-8") as f:
            users = json.load(f)

    salt = os.urandom(16)
    users[user] = {
        "salt": salt.hex(),
        "hash": hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, ITER).hex(),
        "iter": ITER,
    }
    with open(USERS, "w", encoding="utf-8") as f:
        json.dump(users, f, ensure_ascii=False, indent=2)
    os.chmod(USERS, 0o600)

    # 轮换签名密钥，旧 Cookie 立即失效
    with open(SECRET, "wb") as f:
        f.write(os.urandom(32).hex().encode())
    os.chmod(SECRET, 0o600)

    print(f"已设置用户 {user} 的密码，并让所有旧会话失效")
    print("如服务正在运行，请执行： systemctl restart ai-auth")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
