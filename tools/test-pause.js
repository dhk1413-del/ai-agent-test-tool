/**
 * 端到端验证：暂停 / 继续 / 停止
 *  - 起一个本地 mock AI 页面作为被测站点
 *  - 起一个被测服务（独立端口）跑 3 题，中途暂停、继续、再暂停、停止
 *  - 校验状态流转与「已完成结果被保留」
 *
 * 用法: node tools/test-pause.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MOCK_PORT = 3899;
const APP_PORT = 3898;
const TEST_CDP_PORT = 9344;          // 独立端口 + 独立配置目录，避免干扰正在使用的实例
const TEST_DATA = path.join(ROOT, 'data-test');
const TEST_PROFILE = path.join(ROOT, 'chrome-profile-test');
const BASE = `http://127.0.0.1:${APP_PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) { const e = new Error((data && data.error) || text); e.status = res.status; throw e; }
  return data;
}

/* mock 站点 */
function startMock() {
  const html = fs.readFileSync(path.join(__dirname, 'mock-ai', 'index.html'));
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise(r => srv.listen(MOCK_PORT, '127.0.0.1', () => r(srv)));
}

/* 被测服务 */
function startApp() {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      CDP_PORT: String(TEST_CDP_PORT),
      DATA_DIR: TEST_DATA,
      PROFILE_DIR: TEST_PROFILE,
      ANSWER_TIMEOUT: '90',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => { });
  proc.stderr.on('data', d => process.stderr.write('[app:err] ' + d));
  return proc;
}

async function waitHealth(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const h = await api('GET', '/api/health');
      if (h.ok) return h;
    } catch { }
    await sleep(500);
  }
  throw new Error('服务未能就绪');
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  let mock, app;
  const cleanup = async () => {
    try { if (app && !app.killed) app.kill(); } catch { }
    try { if (mock) mock.close(); } catch { }
  };
  try {
    console.log('== 启动 mock 站点与被测服务 ==');
    mock = await startMock();
    app = startApp();
    const h = await waitHealth();
    console.log(`   服务就绪，chrome=${h.chrome}`);

    // 建项目（题目尽量少，缩短验证时间）
    const proj = await api('POST', '/api/projects', {
      name: 'PauseTest',
      url: `http://127.0.0.1:${MOCK_PORT}/`,
      questions: ['Q-ONE', 'Q-TWO', 'Q-THREE'],
    });
    console.log(`   项目 ${proj.id}`);

    console.log('\n== 开始一轮测试 ==');
    const started = await api('POST', `/api/projects/${proj.id}/runs`, { questions: ['Q-ONE', 'Q-TWO', 'Q-THREE'] });
    const rid = started.runId;
    console.log(`   run ${rid}`);

    // 等第一题完成，确认流程正常
    let run = null;
    for (let i = 0; i < 120; i++) {
      await sleep(1000);
      run = await api('GET', `/api/runs/${rid}`);
      const done = (run.results || []).length;
      if (done >= 1) break;
      if (run.status !== 'running') break;
    }
    check('第 1 题已完成', (run.results || []).length >= 1, `results=${(run.results || []).length} status=${run.status}`);

    console.log('\n== 暂停 ==');
    const p1 = await api('POST', `/api/runs/${rid}/pause`);
    check('暂停接口返回 paused', p1.status === 'paused', JSON.stringify(p1));
    run = await api('GET', `/api/runs/${rid}`);
    check('运行状态落库为 paused', run.status === 'paused', `status=${run.status}`);

    // 暂停后不应再产出新结果
    const cntAtPause = (run.results || []).length;
    await sleep(12000);
    run = await api('GET', `/api/runs/${rid}`);
    check('暂停期间不再产出新结果', (run.results || []).length === cntAtPause,
      `暂停时=${cntAtPause} 12秒后=${(run.results || []).length}`);
    check('暂停期间状态保持 paused', run.status === 'paused', `status=${run.status}`);
    check('暂停时不能另起一轮', await (async () => {
      try { await api('POST', `/api/projects/${proj.id}/runs`, { questions: ['X'] }); return false; }
      catch (e) { return e.status === 409; }
    })(), '应返回 409');

    console.log('\n== 继续 ==');
    const r1 = await api('POST', `/api/runs/${rid}/resume`);
    check('继续接口返回 running', r1.status === 'running', JSON.stringify(r1));

    // 恢复后应继续产出结果
    let grew = false;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      run = await api('GET', `/api/runs/${rid}`);
      if ((run.results || []).length > cntAtPause) { grew = true; break; }
      if (run.status !== 'running') break;
    }
    check('继续后继续产出结果', grew, `现在=${(run.results || []).length} status=${run.status}`);

    console.log('\n== 停止 ==');
    const s1 = await api('POST', `/api/runs/${rid}/stop`);
    check('停止接口返回 stopped', s1.status === 'stopped', JSON.stringify(s1));
    await sleep(1500);
    run = await api('GET', `/api/runs/${rid}`);
    check('状态落库为 stopped', run.status === 'stopped', `status=${run.status}`);
    check('停止后保留已完成结果', (run.results || []).length >= 1, `results=${(run.results || []).length}`);
    check('停止后记录结束时间', !!run.finishedAt, `finishedAt=${run.finishedAt}`);

    console.log('\n== 停止后可再起新一轮 ==');
    const again = await api('POST', `/api/projects/${proj.id}/runs`, { questions: ['Q-ONE'] });
    check('可再次开始新一轮', !!again.runId, `新 runId=${again.runId}`);
    // 收尾：立刻停掉，避免测试拖长
    try { await api('POST', `/api/runs/${again.runId}/stop`); } catch { }

    console.log('\n== 对已结束轮次的操作应被拒绝 ==');
    let rejected = false;
    try { await api('POST', `/api/runs/${rid}/pause`); } catch (e) { rejected = e.status === 409; }
    check('对已停止轮次暂停返回 409', rejected, '');

    const failed = results.filter(r => !r.pass);
    console.log(`\n===== 汇总: ${results.length - failed.length}/${results.length} PASS =====`);
    if (failed.length) { failed.forEach(f => console.log('  FAILED: ' + f.name + ' — ' + f.detail)); }
    await cleanup();
    process.exit(failed.length ? 1 : 0);
  } catch (e) {
    console.error('测试异常:', e.message);
    await cleanup();
    process.exit(1);
  }
})();
