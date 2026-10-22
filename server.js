/**
 * AI 机器人问答测试平台 —— HTTP 服务
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const CFG = require('./lib/config');
const store = require('./lib/store');
const chrome = require('./lib/chrome');
const { RobotRunner } = require('./lib/robot');
const { buildRunReport, buildProjectReport } = require('./lib/report');
const questionBank = require('./lib/question-bank');
const ai = require('./lib/ai');

/* ---------------- 基础工具 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function fail(res, code, msg) { json(res, code, { error: msg }); }

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function download(res, buf, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_');
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

/* ---------------- 运行管理 ---------------- */
const activeRuns = new Map();   // runId -> { runner, clients:Set<res> }
const subscribers = new Map();  // runId -> Set<res>

function sseSend(res, payload) {
  try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { }
}

function broadcast(runId, payload) {
  const set = subscribers.get(runId);
  if (!set) return;
  for (const res of set) sseSend(res, payload);
}

function currentSnapshot(runId) {
  const run = store.getRun(runId);
  if (!run) return null;
  return {
    status: run.status, progress: run.progress || null, results: run.results || [],
    engine: run.engine || null, okCount: run.okCount, avgSec: run.avgSec, error: run.error,
  };
}

/* 结束一轮仍在内存中运行的测试，并落库最终状态 */
function finalizeRun(runId, status, extra = {}) {
  const full = store.getRun(runId) || {};
  const results = full.results || [];
  const ok = results.filter(r => r.completed).length;
  const secs = results.map(r => r.elapsedSec).filter(v => typeof v === 'number');
  const patch = {
    status,
    okCount: ok,
    total: full.total || results.length,
    avgSec: secs.length ? Math.round(secs.reduce((a, b) => a + b, 0) / secs.length) : null,
    finishedAt: new Date().toISOString(),
    ...extra,
  };
  store.updateRun(runId, patch);
  broadcast(runId, { type: 'status', ...patch });
  return patch;
}

async function startRun(project, questionsOverride) {
  const active = store.listRuns(project.id).find(r => r.status === 'running' || r.status === 'paused');
  if (active) {
    const e = new Error(active.status === 'paused'
      ? '该项目有一轮测试处于暂停中，请先点「继续」或「停止」'
      : '该项目已有一轮测试正在进行中');
    e.code = 409;
    throw e;
  }

  const questions = (questionsOverride && questionsOverride.length ? questionsOverride : project.questions) || [];
  if (!questions.length) { const e = new Error('测试问题为空，请先配置问题'); e.code = 400; throw e; }
  if (!project.url) { const e = new Error('项目未配置访问地址'); e.code = 400; throw e; }

  const run = store.createRun(project.id);
  store.updateRun(run.id, { total: questions.length });

  const ck = await chrome.ensureChrome();
  if (!ck.ok) {
    store.updateRun(run.id, { status: 'failed', error: ck.error, finishedAt: new Date().toISOString() });
    const e = new Error(ck.error); e.code = 500; throw e;
  }

  const shotsDir = path.join(CFG.SHOTS_DIR, run.id);
  const runner = new RobotRunner({ url: project.url, questions, shotsDir });
  activeRuns.set(run.id, { runner, projectId: project.id });
  store.saveRunData(run.id, { progress: { current: 0, total: questions.length, question: '', phase: 'loading', message: '初始化…' } });

  runner.on('progress', p => {
    store.saveRunData(run.id, { progress: p });
    broadcast(run.id, { type: 'progress', progress: p });
  });
  runner.on('engine', e => {
    if (!e) return;
    store.saveRunData(run.id, { engine: e });
    broadcast(run.id, { type: 'engine', engine: e });
  });
  runner.on('result', r => {
    store.appendResult(run.id, r);
    broadcast(run.id, { type: 'result', result: r });
  });

  runner.run().then(results => {
    const ok = results.filter(r => r.completed).length;
    const secs = results.map(r => r.elapsedSec).filter(v => typeof v === 'number');
    const stopped = runner.cancelled;
    const patch = {
      status: stopped ? 'stopped' : 'done',
      okCount: ok,
      total: results.length,
      avgSec: secs.length ? Math.round(secs.reduce((a, b) => a + b, 0) / secs.length) : null,
      finishedAt: new Date().toISOString(),
    };
    if (stopped) patch.error = '已手动停止';
    store.updateRun(run.id, patch);
    broadcast(run.id, { type: 'status', ...patch });
  }).catch(e => {
    // 已被手动停止的轮次不要覆盖成失败
    if (runner.cancelled) {
      const ok = ((store.getRun(run.id) || {}).results || []).filter(r => r.completed).length;
      const patch = {
        status: 'stopped', okCount: ok, finishedAt: new Date().toISOString(),
        error: '已手动停止',
      };
      store.updateRun(run.id, patch);
      broadcast(run.id, { type: 'status', ...patch });
      return;
    }
    const ok = ((store.getRun(run.id) || {}).results || []).filter(r => r.completed).length;
    const patch = { status: 'failed', error: String(e.message || e).slice(0, 500), okCount: ok, finishedAt: new Date().toISOString() };
    store.updateRun(run.id, patch);
    broadcast(run.id, { type: 'status', ...patch });
  }).finally(() => {
    activeRuns.delete(run.id);
  });

  return run;
}

/* ---------------- 路由 ---------------- */
async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/health' && m === 'GET') {
    const st = await chrome.status();
    return json(res, 200, { ok: true, chrome: st.state, chromeVersion: st.version, chromeError: st.error, version: CFG.VERSION });
  }

  if (p === '/api/state' && m === 'GET') {
    const st = await chrome.status();
    return json(res, 200, { projects: store.listProjects(), chrome: st.state, chromeError: st.error });
  }

  if (p === '/api/chrome/restart' && m === 'POST') {
    const r = await chrome.ensureChrome({ force: true });
    return json(res, 200, { ok: r.ok, error: r.error || null, chrome: r.ok ? 'ready' : 'down' });
  }

  if (p === '/api/question-bank' && m === 'GET') {
    return json(res, 200, questionBank.bank());
  }

  /* ---------------- AI 生成测试问题 ---------------- */

  if (p === '/api/ai/status' && m === 'GET') {
    return json(res, 200, ai.status());
  }

  if (p === '/api/ai/config' && m === 'POST') {
    const b = await readBody(req);
    const patch = {};
    if (typeof b.apiKey === 'string') patch.apiKey = b.apiKey.trim();
    if (typeof b.baseUrl === 'string' && b.baseUrl.trim()) patch.baseUrl = b.baseUrl.trim();
    if (typeof b.model === 'string' && b.model.trim()) patch.model = b.model.trim();
    ai.writeSettings(patch);
    return json(res, 200, ai.status());
  }

  if (p === '/api/ai/test' && m === 'POST') {
    const r = await ai.testConnection();
    return json(res, r.ok ? 200 : 502, r);
  }

  if (p === '/api/ai/generate-questions' && m === 'POST') {
    const b = await readBody(req);
    try {
      const r = await ai.generateQuestions({
        keyword: b.keyword,
        count: b.count,
        existing: b.existing,
      });
      return json(res, 200, r);
    } catch (e) {
      return fail(res, e.code || 500, String(e.message || e));
    }
  }

  if (p === '/api/projects' && m === 'POST') {
    const b = await readBody(req);
    if (!b.name || !String(b.name).trim()) return fail(res, 400, '项目名称不能为空');
    if (!b.url || !/^https?:\/\//i.test(String(b.url).trim())) return fail(res, 400, '请输入以 http(s):// 开头的有效网址');
    const proj = store.createProject({ name: b.name, url: b.url, questions: b.questions });
    return json(res, 201, proj);
  }

  let mm;
  if ((mm = p.match(/^\/api\/projects\/([^/]+)$/))) {
    const id = mm[1];
    if (m === 'GET') {
      const project = store.getProject(id);
      if (!project) return fail(res, 404, '项目不存在');
      const runs = store.listRuns(id).map(r => {
        const { results, ...s } = r;
        return s;
      });
      return json(res, 200, { project, runs });
    }
    if (m === 'PATCH') {
      const b = await readBody(req);
      const project = store.updateProject(id, b);
      if (!project) return fail(res, 404, '项目不存在');
      return json(res, 200, project);
    }
    if (m === 'DELETE') {
      if (!store.getProject(id)) return fail(res, 404, '项目不存在');
      store.deleteProject(id);
      return json(res, 200, { ok: true });
    }
  }

  if ((mm = p.match(/^\/api\/projects\/([^/]+)\/runs$/)) && m === 'POST') {
    const project = store.getProject(mm[1]);
    if (!project) return fail(res, 404, '项目不存在');
    const b = await readBody(req);
    const questions = b && b.questions ? store.normalizeQuestions(b.questions) : null;
    try {
      const run = await startRun(project, questions);
      return json(res, 201, { runId: run.id, index: run.index });
    } catch (e) {
      return fail(res, e.code || 500, e.message);
    }
  }

  if ((mm = p.match(/^\/api\/projects\/([^/]+)\/report\.docx$/)) && m === 'GET') {
    const project = store.getProject(mm[1]);
    if (!project) return fail(res, 404, '项目不存在');
    const runs = store.listRuns(mm[1]).map(r => store.getRun(r.id)).filter(Boolean);
    if (!runs.length) return fail(res, 400, '该项目还没有任何测试轮次');
    try {
      const buf = await buildProjectReport({
        project, runs,
        shotsDirOf: (rid) => path.join(CFG.SHOTS_DIR, rid),
      });
      return download(res, buf, `${project.name}_测试汇总报告.docx`);
    } catch (e) { return fail(res, 500, '生成报告失败：' + e.message); }
  }

  // ---- 暂停 / 继续 / 停止 ----
  if ((mm = p.match(/^\/api\/runs\/([^/]+)\/(pause|resume|stop)$/)) && m === 'POST') {
    const id = mm[1];
    const action = mm[2];
    const run = store.getRun(id);
    if (!run) return fail(res, 404, '测试轮次不存在');
    if (run.status !== 'running' && run.status !== 'paused') {
      return fail(res, 409, `该轮测试已结束（${run.status}），无法${action === 'pause' ? '暂停' : action === 'resume' ? '继续' : '停止'}`);
    }
    const act = activeRuns.get(id);
    if (!act) return fail(res, 409, '该轮测试不在运行中（可能服务已重启），请点「停止」后重新开始');

    if (action === 'pause') {
      act.runner.pause();
      store.updateRun(id, { status: 'paused' });
      broadcast(id, { type: 'status', status: 'paused' });
      return json(res, 200, { ok: true, status: 'paused' });
    }
    if (action === 'resume') {
      act.runner.resume();
      store.updateRun(id, { status: 'running' });
      broadcast(id, { type: 'status', status: 'running' });
      return json(res, 200, { ok: true, status: 'running' });
    }
    // stop：立即停止（正在生成的那一题会被中断），已完成的结果全部保留
    act.runner.cancel();
    const patch = finalizeRun(id, 'stopped', { error: '已手动停止' });
    return json(res, 200, { ok: true, status: 'stopped', okCount: patch.okCount });
  }

  if ((mm = p.match(/^\/api\/runs\/([^/]+)$/))) {
    const id = mm[1];
    if (m === 'GET') {
      const run = store.getRun(id);
      if (!run) return fail(res, 404, '测试轮次不存在');
      return json(res, 200, run);
    }
    // DELETE = 立即停止并保留本轮已完成的记录（只会在轮次已结束时真正删除）
    if (m === 'DELETE') {
      if (!store.getRun(id)) return fail(res, 404, '测试轮次不存在');
      const act = activeRuns.get(id);
      if (act) {
        act.runner.cancel();
        const patch = finalizeRun(id, 'stopped', { error: '已手动停止' });
        return json(res, 200, { ok: true, status: 'stopped', okCount: patch.okCount });
      }
      store.deleteRun(id);
      return json(res, 200, { ok: true, status: 'deleted' });
    }
  }

  if ((mm = p.match(/^\/api\/runs\/([^/]+)\/events$/)) && m === 'GET') {
    const id = mm[1];
    const run = store.getRun(id);
    if (!run) return fail(res, 404, '测试轮次不存在');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    if (!subscribers.has(id)) subscribers.set(id, new Set());
    subscribers.get(id).add(res);

    // 补发快照
    sseSend(res, { type: 'status', status: run.status, okCount: run.okCount, avgSec: run.avgSec, error: run.error });
    if (run.engine) sseSend(res, { type: 'engine', engine: run.engine });
    if (run.progress) sseSend(res, { type: 'progress', progress: run.progress });
    for (const r of run.results || []) sseSend(res, { type: 'result', result: r });

    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { } }, 15000);
    req.on('close', () => { clearInterval(ping); const s = subscribers.get(id); if (s) s.delete(res); });
    return;
  }

  if ((mm = p.match(/^\/api\/runs\/([^/]+)\/report\.docx$/)) && m === 'GET') {
    const run = store.getRun(mm[1]);
    if (!run) return fail(res, 404, '测试轮次不存在');
    const project = store.getProject(run.projectId);
    if (!project) return fail(res, 404, '项目不存在');
    try {
      const buf = await buildRunReport({ project, run, shotsDir: path.join(CFG.SHOTS_DIR, run.id) });
      return download(res, buf, `${project.name}_第${run.index}轮_测试报告.docx`);
    } catch (e) { return fail(res, 500, '生成报告失败：' + e.message); }
  }

  if ((mm = p.match(/^\/api\/runs\/([^/]+)\/shot\/(\d+)$/))) {
    const file = path.join(CFG.SHOTS_DIR, mm[1], `q${String(mm[2]).padStart(2, '0')}.png`);
    if (!fs.existsSync(file)) return fail(res, 404, '截图不存在');
    const buf = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'no-cache' });
    return res.end(buf);
  }

  return fail(res, 404, '接口不存在');
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(CFG.PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(CFG.PUBLIC_DIR)) return fail(res, 403, '禁止访问');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
  const buf = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': buf.length });
  res.end(buf);
}

/* ---------------- 单实例保护 ----------------
   两个进程共用同一个 data 目录会互相破坏状态：启动时的 reconcile 会把
   另一个进程正在跑的轮次标记为「失败」，并可能覆盖 db.json。
   这里用一把锁文件把这种误操作挡住（同机、同数据目录只允许一个实例）。 */
const LOCK_FILE = path.join(CFG.DATA_DIR, '.server.lock');

function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch { return null; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

(function acquireLock() {
  const prev = readLock();
  if (prev && prev.pid !== process.pid && pidAlive(prev.pid)) {
    console.error('');
    console.error('  [错误] 该数据目录已被另一个实例占用：');
    console.error(`         PID ${prev.pid}（端口 ${prev.port}），启动于 ${prev.startedAt}`);
    console.error(`         数据目录：${CFG.DATA_DIR}`);
    console.error('');
    console.error('  同时运行两个实例会互相覆盖测试状态（例如把正在跑的轮次标记为失败）。');
    console.error('  请先停止其中一个，或为本次运行指定独立数据目录，例如：');
    console.error('     set DATA_DIR=D:\\tmp\\ai-tester-data && node server.js');
    console.error('');
    process.exit(1);
  }
  const writeLock = () => {
    try {
      fs.writeFileSync(LOCK_FILE, JSON.stringify({
        pid: process.pid, port: CFG.PORT, startedAt: new Date().toISOString(),
      }, null, 2), 'utf8');
    } catch { }
  };
  writeLock();
  const hb = setInterval(writeLock, 10000);
  if (hb.unref) hb.unref();

  const release = () => {
    try {
      const cur = readLock();
      if (cur && cur.pid === process.pid) fs.rmSync(LOCK_FILE, { force: true });
    } catch { }
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { release(); process.exit(0); });
  }
})();

/* ---------------- 启动 ---------------- */
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    try { fail(res, 500, String(e.message || e)); } catch { }
  }
}

// 同一个 http.Server 不能绑两个地址（listen 只能调用一次），
// 因此本机(:127.0.0.1)与局域网(:0.0.0.0)各建一个 Server，共用同一套请求处理。
const server = http.createServer(handleRequest);

/* 局域网访问：默认开启，便于同网段的手机/其它电脑打开。
   设 AI_TESTER_LAN=0 可关闭（只保留本机 127.0.0.1 访问）。 */
const LAN_ENABLED = process.env.AI_TESTER_LAN !== '0';
/* Linux/macOS 下不能先绑 127.0.0.1 再绑 0.0.0.0：第二次必然 EADDRINUSE。
   非 Windows 且需要局域网访问时，单个 0.0.0.0 监听即可同时覆盖 127.0.0.1。 */
const SINGLE_WILDCARD = LAN_ENABLED && process.platform !== 'win32';
let lanServer = null;

function localIPv4List() {
  const os = require('os');
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

// 服务重启后，「运行中」的轮次已无 runner 可用，标记为失败。
// 暂停中的轮次保留「暂停」状态：它在内存里的 runner 同样没了，前端点「继续」
// 会收到明确提示，用户可以自行点「停止」收尾或重新开始。
(function reconcile() {
  const db = store.readDb();
  let n = 0;
  for (const r of db.runs) {
    if (r.status === 'running') {
      r.status = 'failed';
      r.error = '服务重启导致该轮测试中断';
      r.finishedAt = new Date().toISOString();
      n++;
    }
  }
  if (n) { store.writeDb(db); console.log(`[启动] 已将 ${n} 个中断的轮次标记为失败`); }
})();

server.listen(CFG.PORT, SINGLE_WILDCARD ? '0.0.0.0' : '127.0.0.1', async () => {
  const st = await chrome.status();
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║      AI 机器人问答测试平台 已启动            ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
  console.log(`  本机访问： http://127.0.0.1:${CFG.PORT}`);
  console.log(`  数据目录： ${CFG.DATA_DIR}`);
  console.log(`  受控浏览器：${st.state === 'ready' ? '已就绪 ' + (st.version || '') : (CFG.CHROME || '未找到 Chrome')}`);
  if (!CFG.CHROME) console.log('  ⚠ 未检测到 Chrome/Edge，请安装后重启本程序。');
  console.log('');

  if (SINGLE_WILDCARD) {
    const ips = localIPv4List();
    if (ips.length) {
      console.log('  局域网访问（同一网段的其他设备可打开）：');
      ips.forEach(ip => console.log(`    http://${ip}:${CFG.PORT}`));
    } else {
      console.log('  ⚠ 未检测到局域网 IP，请确认已连接 WiFi/网线。');
    }
    console.log('');
  } else if (LAN_ENABLED) {
    lanServer = http.createServer(handleRequest);
    lanServer.on('error', (e) => {
      console.log(`  ⚠ 局域网访问未能开启（${e.code}）：${e.message}`);
      console.log('    可能是端口被占用或缺少防火墙放行。可设 AI_TESTER_LAN=0 静默关闭。');
      console.log('');
    });
    lanServer.listen(CFG.PORT, '0.0.0.0', () => {
      const ips = localIPv4List();
      if (ips.length) {
        console.log('  局域网访问（同一 WiFi/网段的其他设备可打开）：');
        ips.forEach(ip => console.log(`    http://${ip}:${CFG.PORT}`));
      } else {
        console.log('  ⚠ 未检测到局域网 IP，请确认已连接 WiFi/网线。');
      }
      console.log('');
      console.log('  提示：首次从其他设备访问若打不开，多为 Windows 防火墙未放行，');
      console.log(`        以管理员身份执行一次：`);
      console.log(`        netsh advfirewall firewall add rule name="AI Tester ${CFG.PORT}" dir=in action=allow protocol=TCP localport=${CFG.PORT}`);
      console.log('');
    });
  } else {
    console.log('  局域网访问已关闭（AI_TESTER_LAN=0），仅本机可访问。');
    console.log('');
  }

  console.log('  按 Ctrl+C 退出');
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\n正在退出…');
  process.exit(0);
});
