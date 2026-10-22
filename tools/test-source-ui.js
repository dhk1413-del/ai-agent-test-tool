/**
 * 验证「测试结果」新增的「来源」列：
 *  - 表头出现「来源」
 *  - 三种来源分别渲染为 蓝/绿/红 徽章，文字正确
 *  - 展开行详情里有「回答来源」与页面署名
 *  - 兼容旧数据（无 source 字段时按 attribution 现判）
 * 用法: node tools/test-source-ui.js
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
    id: 'p_src', name: '来源列验证', url: 'https://example.com/chat',
    questions: ['Q1', 'Q2', 'Q3', 'Q4'], runCount: 1, createdAt: new Date().toISOString(),
  };
  // 4 题：问答库 / 单位知识库 / 其他（有新 source 字段）/ 旧数据（只有 attribution）
  const run = {
    id: 'r_src', projectId: 'p_src', index: 1, total: 4, status: 'done',
    startedAt: new Date(Date.now() - 300000).toISOString(),
    finishedAt: new Date().toISOString(),
    okCount: 4, avgSec: 10, error: null,
    progress: { current: 4, total: 4, question: 'Q4', phase: 'done', message: '' },
    results: [
      { index: 1, question: '问答库来源的问题', answer: '答案一', completed: true, elapsedSec: 9, card: false,
        attribution: '该答案由AI大模型总结生成，内容来自：问答库',
        source: { category: 'qa', label: '问答库', raw: '该答案由AI大模型总结生成，内容来自：问答库' } },
      { index: 2, question: '知识库来源的问题', answer: '答案二', completed: true, elapsedSec: 11, card: false,
        attribution: '该答案由AI大模型总结生成，内容来自：单位AI知识库',
        source: { category: 'unit', label: '单位AI知识库', raw: '该答案由AI大模型总结生成，内容来自：单位AI知识库' } },
      { index: 3, question: '无来源的问题', answer: '答案三', completed: true, elapsedSec: 7, card: false,
        attribution: '该答案由AI大模型生成',
        source: { category: 'other', label: '', raw: '该答案由AI大模型生成' } },
      // 旧数据：没有 source，只有 attribution —— 前端应当现场判定出来
      { index: 4, question: '旧数据无 source 字段', answer: '答案四', completed: true, elapsedSec: 8, card: false,
        attribution: '该答案由AI大模型总结生成，内容来自：单位AI知识库' },
    ],
  };

  window.__calls = [];
  const json = (o) => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(o)) });
  const orig = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    const u = String(url);
    if (!u.startsWith('/api/')) return orig(url, opts);
    window.__calls.push(((opts && opts.method) || 'GET') + ' ' + u);
    if (u === '/api/state') return json({ projects: [project], chrome: 'ready' });
    if (u === '/api/ai/status') return json({ configured: false });
    if (u === '/api/health') return json({ ok: true, chrome: 'ready', chromeVersion: 'x', version: '1' });
    if (u === '/api/question-bank') return json({ categories: [] });
    if (u === '/api/projects/p_src') return json({ project, runs: [run] });
    if (u === '/api/runs/r_src') return json(run);
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
    await page.goto(APP + '?src=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 1800));

    await page.evaluate(() => {
      const el = document.querySelector('[data-act="select-project"]');
      if (el) el.click();
    });
    await new Promise(r => setTimeout(r, 1200));
    // 打开轮次详情
    await page.evaluate(() => {
      const b = document.querySelector('[data-act="open-run"]');
      if (b) b.click();
    });
    await new Promise(r => setTimeout(r, 1500));

    const head = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.res-table thead th')).map(t => t.textContent.trim()));
    console.log('表头: ' + JSON.stringify(head));
    check('表头包含「来源」', head.includes('来源'), head.join(' | '));
    check('「来源」列位于「回答字数」与「结果」之间',
      head.indexOf('来源') === head.indexOf('回答字数') + 1, head.join(' | '));

    const badges = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.res-table tbody .res-row')).map(tr => {
        const b = tr.querySelector('.src-badge');
        if (!b) return null;
        const cs = getComputedStyle(b);
        return { text: b.textContent.trim(), cls: b.className, color: cs.color, bg: cs.backgroundColor };
      }));
    console.log('\n各行来源徽章:');
    badges.forEach((b, i) => console.log(`  第${i + 1}题: ${b ? b.text + '  ' + b.cls + '  字色' + b.color : '(无)'}`));

    check('第1题 问答库/蓝色', !!badges[0] && badges[0].text === '问答库' && /src-qa/.test(badges[0].cls)
      && badges[0].color === 'rgb(26, 86, 219)', badges[0] && badges[0].color);
    check('第2题 单位AI知识库/绿色', !!badges[1] && badges[1].text === '单位AI知识库' && /src-unit/.test(badges[1].cls)
      && badges[1].color === 'rgb(30, 123, 52)', badges[1] && badges[1].color);
    check('第3题 其他/红色', !!badges[2] && /src-other/.test(badges[2].cls)
      && badges[2].color === 'rgb(192, 57, 43)', badges[2] && badges[2].text + ' ' + badges[2].color);
    check('第4题（旧数据无 source）也能判定为绿色', !!badges[3] && /src-unit/.test(badges[3].cls),
      badges[3] && badges[3].text);

    // 展开第一行，看详情里的来源
    await page.evaluate(() => {
      const tr = document.querySelector('.res-table tbody .res-row');
      if (tr) tr.click();
    });
    await new Promise(r => setTimeout(r, 800));
    const detail = await page.evaluate(() => {
      const d = document.querySelector('.res-detail.open .detail-body');
      if (!d) return null;
      return {
        labels: Array.from(d.querySelectorAll('.detail-label')).map(x => x.textContent.trim()),
        srcText: (d.querySelector('.detail-source') || {}).textContent || '',
        badge: (d.querySelector('.detail-source .src-badge') || {}).textContent || '',
      };
    });
    check('展开详情含「回答来源」', !!detail && detail.labels.includes('回答来源'), detail ? detail.labels.join(',') : 'no detail');
    check('详情来源徽章为问答库', !!detail && detail.badge.trim() === '问答库', detail && detail.badge);
    check('详情显示页面署名原文', !!detail && /页面署名/.test(detail.srcText), detail && detail.srcText.slice(0, 50));

    const out = 'data/logs/source-ui.png';
    await page.screenshot({ path: out, fullPage: false });
    console.log('\nscreenshot -> ' + out);

    const failed = results.filter(r => !r.pass);
    console.log(`\n===== 汇总: ${results.length - failed.length}/${results.length} PASS =====`);
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    await page.close();
    await browser.disconnect();
  }
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
