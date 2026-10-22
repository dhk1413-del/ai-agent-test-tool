#!/usr/bin/env bash
# ---------------------------------------------------------------
# 容器入口: 虚拟显示 + VNC + Node 服务
# 设 AI_TESTER_HEADLESS=1 可跳过 Xvfb/VNC, 纯无头运行
# ---------------------------------------------------------------
set -euo pipefail

export DATA_DIR="${DATA_DIR:-/app/data}"
export PROFILE_DIR="${PROFILE_DIR:-/app/chrome-profile}"
export AI_TESTER_CHROME="${AI_TESTER_CHROME:-/usr/bin/chromium}"
export AI_TESTER_NO_SANDBOX="${AI_TESTER_NO_SANDBOX:-1}"
export AI_TESTER_LAN="${AI_TESTER_LAN:-1}"
export TZ="${TZ:-Asia/Shanghai}"

mkdir -p "$DATA_DIR" "$DATA_DIR/logs" "$DATA_DIR/runs" "$DATA_DIR/shots" "$PROFILE_DIR"

# profile 目录是持久化卷：容器被重建/强杀时，里面的 Chromium 来不及删除
# Singleton 锁，残留后新实例会被判为「数据目录已被另一个实例占用」而秒退，
# 表现为「浏览器已启动但调试端口未就绪」、之后每轮测试都失败。
# 刚启动的容器里不可能有存活的 Chromium，所以这里直接清理是安全的。
rm -f "$PROFILE_DIR"/SingletonLock "$PROFILE_DIR"/SingletonSocket "$PROFILE_DIR"/SingletonCookie 2>/dev/null || true

XVFB_PID=""; X11VNC_PID=""; NOVNC_PID=""; NODE_PID=""; WATCHDOG_PID=""
cleanup() {
    for pid in "$WATCHDOG_PID" "$NODE_PID" "$NOVNC_PID" "$X11VNC_PID" "$XVFB_PID"; do
        [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    done
}
trap cleanup EXIT INT TERM

echo "[entrypoint] 浏览器: $AI_TESTER_CHROME"
echo "[entrypoint] 数据目录: $DATA_DIR"
echo "[entrypoint] 配置目录: $PROFILE_DIR"

if [ "${AI_TESTER_HEADLESS:-0}" = "1" ]; then
    echo "[entrypoint] 无头模式（不启动 Xvfb / VNC）"
    node server.js &
    NODE_PID=$!
    wait "$NODE_PID"
    exit $?
fi

DISPLAY_NUM="${DISPLAY_NUM:-99}"
export DISPLAY=":${DISPLAY_NUM}"
XVFB_LOCK="/tmp/.X${DISPLAY_NUM}-lock"
XVFB_SOCKET="/tmp/.X11-unix/X${DISPLAY_NUM}"

# 「docker restart」（不是重建）时容器 /tmp 会保留，上一次运行的显示锁与
# socket 残留下来：新 Xvfb 会以「Server is already active for display 99」
# 直接退出，而残留 socket 又让「文件是否存在」这种就绪判断误判成已就绪，
# 最后表现为 Chromium 报 Missing X server → 「调试端口未就绪」。
# 新容器里不可能有存活的 Xvfb，所以这里先清掉。
clean_display_artifacts() {
    rm -f "$XVFB_LOCK" "$XVFB_SOCKET" 2>/dev/null || true
}

# 启动 Xvfb 并**用进程存活 + 能应答**来判断就绪（不再只看 socket 文件存在）
start_xvfb() {
    clean_display_artifacts
    echo "[entrypoint] 启动虚拟显示 ${DISPLAY} (1440x960x24)"
    Xvfb "$DISPLAY" -screen 0 1440x960x24 -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
    XVFB_PID=$!
    for _ in $(seq 1 60); do
        kill -0 "$XVFB_PID" 2>/dev/null || break
        if [ -e "$XVFB_SOCKET" ]; then
            sleep 0.2
            break
        fi
        sleep 0.25
    done
    if ! kill -0 "$XVFB_PID" 2>/dev/null; then
        echo "[entrypoint] 警告: Xvfb 启动失败（见 /tmp/xvfb.log）："
        sed 's/^/    /' /tmp/xvfb.log 2>/dev/null | tail -5 || true
        return 1
    fi
    return 0
}

start_x11vnc() {
    VNC_ARGS=(-display "$DISPLAY" -forever -shared -rfbport 5900 -quiet -noxdamage)
    if [ -n "${VNC_PASSWORD:-}" ]; then
        VNC_ARGS+=(-passwd "$VNC_PASSWORD")
    else
        VNC_ARGS+=(-nopw)
    fi
    x11vnc "${VNC_ARGS[@]}" >/tmp/x11vnc.log 2>&1 &
    X11VNC_PID=$!
    sleep 0.5
    return 0
}

if start_xvfb; then
    if [ -n "${VNC_PASSWORD:-}" ]; then
        echo "[entrypoint] x11vnc 已启用密码"
    else
        echo "[entrypoint] x11vnc 无密码（compose 已限制仅 127.0.0.1 可访问）"
    fi
    start_x11vnc
else
    echo "[entrypoint] 重试一次启动虚拟显示 ..."
    if start_xvfb; then
        start_x11vnc
    else
        # 兜底：没有可用显示时改为无头运行，至少让测试能跑（看不到浏览器画面，
        # 需要用 noVNC 登录站点的场景请先修好显示层再重试）
        echo "[entrypoint] 虚拟显示不可用，回退为无头模式（AI_TESTER_HEADLESS=1）"
        echo "[entrypoint] 此时无法用 noVNC 观察/登录，如需该能力请检查 /tmp/xvfb.log"
        export AI_TESTER_HEADLESS=1
    fi
fi

if [ -d /usr/share/novnc ]; then
    websockify --web=/usr/share/novnc/ 7900 localhost:5900 >/tmp/novnc.log 2>&1 &
    NOVNC_PID=$!
    echo "[entrypoint] noVNC: http://localhost:7900/vnc.html"
fi

# 运行期看门狗：Xvfb / x11vnc 若中途退出，Chromium 会以
# 「Missing X server or $DISPLAY」失败并让每轮测试都跑不起来，这里自动拉起。
watchdog() {
    while true; do
        sleep 15
        if [ "${AI_TESTER_HEADLESS:-0}" != "1" ] && ! kill -0 "$XVFB_PID" 2>/dev/null; then
            echo "[entrypoint] 检测到虚拟显示已退出，自动重启 ..."
            if start_xvfb; then start_x11vnc; fi
        elif [ "${AI_TESTER_HEADLESS:-0}" != "1" ] && [ -n "$X11VNC_PID" ] && ! kill -0 "$X11VNC_PID" 2>/dev/null; then
            echo "[entrypoint] 检测到 x11vnc 已退出，自动重启 ..."
            start_x11vnc
        fi
    done
}
watchdog &
WATCHDOG_PID=$!

echo "[entrypoint] 启动 Node 服务 ..."
node server.js &
NODE_PID=$!
wait "$NODE_PID"
