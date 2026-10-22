/**
 * 验证「暂停 / 继续 / 停止」界面（不依赖真实运行中的测试）
 * 通过替换 window.fetch 注入可控的轮次状态，检查：
 *  - 进行中时出现「暂停」+「停止」
 *  - 暂停时出现「继续」+「停止」及暂停提示
 *  - 点击后发出的 API 请求正确
 */
const puppeteer = require('puppeteer-core');
const APP = 'http://127.0.0.1:3789/';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function stubScript() {
  const project = {
    id: 'p_test', name: 'PauseUI', url: 'https://example.com/chat',
    questions: ['Q1', 'Q2', 'Q3'], runCount: 1,
    createdAt: new Date().toISOString(), lastRunAt: null,
  };
  const baseRun = {
    id: 'r_test', projectId: 'p_test', index: 1, total: 3,
    startedAt: new Date(Date.now() - 60000).toISOString(), finishedAt: null,
    status: 'running', okCount: 1, avgSec: 12, error: null,
    progress: { current: 2, total: 3, question: 'Q2', phase: 'waiting', message: '等待回答中 3s' },
    results: [{ index: 1, question: 'Q1', answer: 'A1', completed: true, elapsedSec: 12, card: false }],
  };

  window.__calls = [];
  window.__run = JSON.parse(JSON.stringify(baseRun));

  const json = (obj) => Promise.resolve({
    ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(obj)),
  });

  const origFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    const method = (opts && opts.method) || 'GET';
    const u = String(url);
    if (!u.startsWith('/api/')) return origFetch(url, opts);
    window.__calls.push(method + ' ' + u);

    if (u === '/api/state') return json({ projects: [project], chrome: 'ready', chromeError: null });
    if (u === '/api/ai/status') return json({ configured: false });
    if (u === '/api/health') return json({ ok: true, chrome: 'ready', chromeVersion: 'test', version: '1.0' });
    if (u === '/api/question-bank') return json({ categories: [] });
    if (u === '/api/projects/p_test') return json({ project: project, runs: [Object.assign({}, window.__run, { results: undefined })] });
    if (u === '/api/runs/r_test') return json(window.__run);

    // 暂停 / 继续 / 停止：修改内存状态并返回新状态
    const m = u.match(/^\/api\/runs\/r_test\/(pause|resume|stop)$/);
    if (m) {
      const act = m[1];
      if (act === 'pause') window.__run.status = 'paused';
      if (act === 'resume') window.__run.status = 'running';
      if (act === 'stop') { window.__run.status = 'stopped'; window.__run.finishedAt = new Date().toISOString(); }
      return json({ ok: true, status: window.__run.status, okCount: window.__run.okCount });
    }
    return json({});
  };
}

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333', defaultViewport: null, protocolTimeout: 120000 });
  const page = await browser.newPage();
  try {
    await page.setCacheEnabled(false);
    await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(stubScript);
    // SSE 会真的去连后端，这里让它失败即可（有轮询降级）
    await page.goto(APP + '?ui=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));

    // 进入项目
    await page.evaluate(() => {
      const el = document.querySelector('[data-act="select-project"]');
      if (el) el.click();
    });
    await new Promise(r => setTimeout(r, 1500));

    const runningState = await page.evaluate(() => ({
      pause: !!document.querySelector('[data-act="pause-run"]'),
      resume: !!document.querySelector('[data-act="resume-run"]'),
      stop: !!document.querySelector('[data-act="stop-run"]'),
      cardVisible: !document.querySelector('#progress-card').classList.contains('hidden'),
      title: (document.querySelector('#progress-card .card-title') || {}).textContent || '',
      statusLabel: (document.querySelector('#progress-card') || {}).innerText ? '' : '',
    }));
    check('进行中：显示「暂停」按钮', runningState.pause, JSON.stringify(runningState));
    check('进行中：显示「停止」按钮', runningState.stop, '');
    check('进行中：不显示「继续」', !runningState.resume, '');
    check('进行中：进度卡可见', runningState.cardVisible, `title=${runningState.title}`);

    console.log('\n== 点击暂停 ==');
    await page.click('[data-act="pause-run"]');
    await new Promise(r => setTimeout(r, 1200));

    const pausedState = await page.evaluate(() => ({
      calls: window.__calls.slice(),
      pause: !!document.querySelector('[data-act="pause-run"]'),
      resume: !!document.querySelector('[data-act="resume-run"]'),
      stop: !!document.querySelector('[data-act="stop-run"]'),
      title: (document.querySelector('#progress-card .card-title') || {}).textContent || '',
      note: (document.querySelector('.paused-note') || {}).textContent || '',
      badge: (document.querySelector('#progress-card .badge') || {}).textContent || '',
      runStatus: window.__run.status,
    }));
    check('点击后请求了 pause 接口',
      pausedState.calls.some(c => c === 'POST /api/runs/r_test/pause'), JSON.stringify(pausedState.calls.slice(-3)));
    check('暂停后显示「继续」按钮', pausedState.resume, '');
    check('暂停后不显示「暂停」按钮', !pausedState.pause, '');
    check('暂停后仍可「停止」', pausedState.stop, '');
    check('进度卡标题变为已暂停', /已暂停/.test(pausedState.title), `title=${pausedState.title}`);
    check('显示暂停说明文案', /继续|停止/.test(pausedState.note), pausedState.note.slice(0, 40));

    console.log('\n== 点击继续 ==');
    await page.click('[data-act="resume-run"]');
    await new Promise(r => setTimeout(r, 1200));
    const resumed = await page.evaluate(() => ({
      calls: window.__calls.slice(),
      pause: !!document.querySelector('[data-act="pause-run"]'),
      runStatus: window.__run.status,
      title: (document.querySelector('#progress-card .card-title') || {}).textContent || '',
    }));
    check('点击后请求了 resume 接口',
      resumed.calls.some(c => c === 'POST /api/runs/r_test/resume'), '');
    check('继续后回到进行中', resumed.pause && resumed.runStatus === 'running', `title=${resumed.title}`);

    console.log('\n== 点击停止（确认弹窗） ==');
    page.on('dialog', async d => { await d.accept(); });
    await page.click('[data-act="stop-run"]');
    await new Promise(r => setTimeout(r, 1500));
    const stopped = await page.evaluate(() => ({
      calls: window.__calls.slice(),
      progressHidden: document.querySelector('#progress-card').classList.contains('hidden'),
      runStatus: window.__run.status,
    }));
    check('点击后请求了 stop 接口',
      stopped.calls.some(c => c === 'POST /api/runs/r_test/stop'), '');
    check('停止后收起进度卡', stopped.progressHidden, `status=${stopped.runStatus}`);

    const failed = results.filter(r => !r.pass);
    console.log(`\n===== 汇总: ${results.length - failed.length}/${results.length} PASS =====`);
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    await page.close();
    await browser.disconnect();
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
