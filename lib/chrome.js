/**
 * 受控浏览器生命周期管理
 * 采用「独立进程启动 Chrome + puppeteer.connect」的方式：
 *  - 避免 puppeteer 默认用管道 stdio 拉起浏览器（部分受限环境会 EPERM）
 *  - 所有测试轮次复用同一个浏览器实例，速度快、也更稳定
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CFG = require('./config');

let puppeteer = null;
try { puppeteer = require('puppeteer-core'); } catch { puppeteer = null; }

let lastError = null;
let spawning = null;

function cdpGet(pathname, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: CFG.CDP_PORT, path: pathname, timeout }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { resolve(body); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function isAlive() {
  try {
    const v = await cdpGet('/json/version');
    return v && v.webSocketDebuggerUrl ? v : false;
  } catch { return false; }
}

function chromeArgs() {
  const args = [
    `--remote-debugging-port=${CFG.CDP_PORT}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${CFG.PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--disable-features=Translate,MediaRouter',
    `--window-size=${CFG.VIEWPORT.width},${CFG.VIEWPORT.height}`,
    '--window-position=40,20',
    'about:blank',
  ];
  if (process.env.AI_TESTER_NO_SANDBOX === '1') args.unshift('--no-sandbox');
  if (process.env.AI_TESTER_HEADLESS === '1') args.unshift('--headless=new');
  return args;
}

/* ---------------- 配置目录单实例锁 ----------------
   Chromium 会在配置目录里放 SingletonLock/SingletonSocket/SingletonCookie，
   防止同一配置目录被两个实例同时打开。SingletonLock 是指向 "<hostname>-<pid>"
   的软链。进程被强杀（SIGKILL、OOM、容器重建、任务管理器结束）时 Chromium
   来不及清理，这些锁就会留在目录里；之后新的 Chromium 启动时读到锁，
   直接以「The profile appears to be in use by another Chromium process」退出，
   于是调试端口永远不就绪 —— 表现为「浏览器已启动但调试端口未就绪」，
   且此后每一轮测试都会立刻失败。这里在启动前判断并清理这种死锁。 */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readSingletonLock() {
  const lockPath = path.join(CFG.PROFILE_DIR, 'SingletonLock');
  let target;
  try { target = fs.readlinkSync(lockPath); } catch { return null; }
  const m = /^(.*)-(\d+)$/.exec(String(target));
  if (!m) return null;                       // 格式不认识：保守起见不动它
  return { lockPath, target, host: m[1], pid: Number(m[2]) };
}

/* 清理「锁里的进程已经不存在」的死锁。返回清理掉的文件数。
   注意：宿主机名与当前不一致时（例如容器被重建、主机名变了）无法判断进程
   是否存活，这里不动它 —— 容器启动时由 entrypoint.sh 统一清理。 */
function clearStaleProfileLocks({ force = false } = {}) {
  const info = readSingletonLock();
  if (!info) return 0;
  if (!force) {
    if (info.host !== os.hostname()) return 0;
    if (pidAlive(info.pid)) return 0;
  }
  let n = 0;
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { fs.unlinkSync(path.join(CFG.PROFILE_DIR, f)); n++; } catch { }
  }
  if (n) console.log(`[chrome] 已清理过期的配置目录锁（锁内容 ${info.target}，对应进程不存在）`);
  return n;
}

/* 仍在占用本配置目录的浏览器进程（Linux 下查 /proc；其它平台返回空数组）。
   用于「有进程活着但调试端口没起来」时强制清掉，再重新拉起。 */
function profileChromePids() {
  const pids = [];
  try {
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const cmd = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8');
        if (cmd.includes(CFG.PROFILE_DIR) && /chrom/i.test(cmd)) pids.push(Number(name));
      } catch { }
    }
  } catch { }
  return pids;
}

function killProfileChrome() {
  const pids = profileChromePids();
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { } }
  if (pids.length) console.log(`[chrome] 已结束占用配置目录的残留浏览器进程：${pids.join(', ')}`);
  return pids.length;
}

/* 浏览器自身的输出留一份日志，便于出错时定位（原来 stdio 直接丢弃） */
function chromeLogFd() {
  try {
    const dir = path.join(CFG.DATA_DIR, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    return fs.openSync(path.join(dir, 'chrome.log'), 'a');
  } catch { return 'ignore'; }
}

function chromeLogTail(lines = 6) {
  try {
    const p = path.join(CFG.DATA_DIR, 'logs', 'chrome.log');
    return fs.readFileSync(p, 'utf8').trim().split('\n').slice(-lines).join(' | ');
  } catch { return ''; }
}

async function ensureChrome({ force = false, retried = false } = {}) {
  if (spawning) { await spawning; return ensureChrome({ force, retried }); }

  if (force) await closeBrowser();

  const alive = await isAlive();
  if (alive) return { ok: true, version: alive.Browser, reused: true };

  if (!CFG.CHROME) {
    lastError = '未找到 Chrome / Edge 可执行文件。请安装 Google Chrome，或设置环境变量 AI_TESTER_CHROME 指向浏览器路径。';
    return { ok: false, error: lastError };
  }

  // 启动前先清掉「锁里的进程已不存在」的死锁，否则新实例会被判为目录被占用而秒退
  clearStaleProfileLocks();

  spawning = (async () => {
    const out = chromeLogFd();
    try {
      const child = spawn(CFG.CHROME, chromeArgs(), {
        detached: true,
        stdio: ['ignore', out, out],
        windowsHide: false,
      });
      child.unref();
    } catch (e) {
      lastError = '启动浏览器进程失败：' + e.message;
    } finally {
      if (typeof out === 'number') { try { fs.closeSync(out); } catch { } }
    }
  })();
  await spawning;
  spawning = null;

  if (lastError && !(await isAlive())) return { ok: false, error: lastError };

  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 700));
    const v = await isAlive();
    if (v) { lastError = null; return { ok: true, version: v.Browser, reused: false }; }
  }

  // 自动恢复一次：杀掉仍占用该配置目录的残留进程、清掉过期锁，再重新拉起
  if (!retried) {
    console.log('[chrome] 调试端口未就绪，自动恢复：清理残留进程与过期锁后重试一次');
    killProfileChrome();
    clearStaleProfileLocks({ force: true });
    await new Promise(r => setTimeout(r, 1200));
    return ensureChrome({ retried: true });
  }

  const tail = chromeLogTail();
  lastError = `浏览器已启动但调试端口（127.0.0.1:${CFG.CDP_PORT}）未就绪，自动重试一次仍失败。`
    + '最常见原因是浏览器被强杀（结束进程/容器重建）后配置目录里留下了过期锁，'
    + '或该配置目录正被另一个实例占用。可点侧边栏「重启浏览器」重试，'
    + '日志见 data/logs/chrome.log。'
    + (tail ? `\n浏览器输出：${tail}` : '');
  return { ok: false, error: lastError };
}

async function connect() {
  if (!puppeteer) throw new Error('缺少 puppeteer-core 依赖，请先执行 npm install');
  const r = await ensureChrome();
  if (!r.ok) throw new Error(r.error);
  return await puppeteer.connect({
    browserURL: `http://127.0.0.1:${CFG.CDP_PORT}`,
    defaultViewport: null,
    protocolTimeout: 600000,
  });
}

async function closeBrowser() {
  try {
    const b = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${CFG.CDP_PORT}`,
      defaultViewport: null,
      protocolTimeout: 15000,
    });
    await b.close();
    await new Promise(r => setTimeout(r, 1500));
    clearStaleProfileLocks({ force: true });   // 正常退出会自己删锁，这里兜底
    return true;
  } catch { return false; }
}

async function status() {
  const v = await isAlive();
  return { state: v ? 'ready' : 'down', version: v ? v.Browser : null, error: v ? null : lastError };
}

module.exports = {
  ensureChrome, connect, closeBrowser, status, isAlive, cdpGet,
  // 供入口/运维脚本复用
  clearStaleProfileLocks, killProfileChrome,
};
