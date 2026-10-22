/**
 * 真实站点跑 3 题 -> 落到测试数据目录 -> 生成报告 -> 校验来源与颜色
 * 独立 DATA_DIR，避免污染正式数据。
 * 用法: node tools/test-report-live.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const TEST_DATA = path.join(ROOT, 'data-reporttest');
process.env.DATA_DIR = TEST_DATA;

const CFG = require('../lib/config');
const store = require('../lib/store');
const { RobotRunner, deriveSource } = require('../lib/robot');
const { buildRunReport } = require('../lib/report');

const URL_ = 'https://robot.chaoxing.com/coze/web?accessToken=xxx&unitId=xxx&robotId=xxx';
// 第 3 题刻意问一个知识库覆盖不到的问题，用来触发「其他」来源
const QUESTIONS = [
  '图书馆的开放时间是怎样安排的？',
  '如何预约座位？',
  '请用一句话解释量子纠缠',
];

function docXml(buf) {
  const data = buf;
  let i = 0;
  while (i < data.length - 4) {
    if (data.readUInt32LE(i) === 0x04034b50) {
      const method = data.readUInt16LE(i + 8);
      const compSize = data.readUInt32LE(i + 18);
      const nameLen = data.readUInt16LE(i + 26);
      const extraLen = data.readUInt16LE(i + 28);
      const name = data.slice(i + 30, i + 30 + nameLen).toString('utf8');
      const start = i + 30 + nameLen + extraLen;
      if (name === 'word/document.xml') {
        const raw = data.slice(start, start + compSize);
        return method === 0 ? raw.toString('utf8') : zlib.inflateRawSync(raw).toString('utf8');
      }
      i = start + compSize;
    } else i++;
  }
  return '';
}

(async () => {
  const shotsDir = path.join(CFG.SHOTS_DIR, 'live');
  fs.mkdirSync(shotsDir, { recursive: true });

  const runner = new RobotRunner({ url: URL_, questions: QUESTIONS, shotsDir, answerTimeoutSec: 150 });
  runner.on('progress', p => { if (p.message && p.phase !== 'waiting') console.log(`  [${p.phase}] ${p.message}`); });
  runner.on('result', r => console.log(`  ✓ 第 ${r.index} 题完成  source=${r.source ? r.source.category : '?'}  label=${r.source ? r.source.label : ''}`));

  const results = await runner.run();
  console.log('\n===== 每题来源 =====');
  results.forEach(r => {
    console.log(`  第 ${r.index} 题: category=${r.source && r.source.category}  label=${r.source && r.source.label}`);
    console.log(`            attribution=${JSON.stringify(r.attribution)}  recall=${JSON.stringify(r.recall)}`);
  });

  const cats = new Set(results.map(r => r.source && r.source.category));
  console.log('\n出现的来源类别: ' + [...cats].join(', '));

  // 生成报告
  const run = {
    id: 'r_live', projectId: 'p_live', index: 1, status: 'done',
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    total: results.length, okCount: results.filter(r => r.completed).length,
    results,
  };
  const project = { id: 'p_live', name: '来源颜色验证', url: URL_, questions: QUESTIONS };
  const buf = await buildRunReport({ project, run, shotsDir });
  const out = path.join(CFG.DATA_DIR, 'live-report.docx');
  fs.writeFileSync(out, buf);
  console.log('\n报告: ' + out + '  (' + (buf.length / 1024).toFixed(0) + ' KB)');

  const xml = docXml(buf);
  console.log('\n===== 报告颜色校验 =====');
  const checks = [
    ['蓝色 1A56DB（问答库）', xml.includes('1A56DB')],
    ['绿色 1E7B34（单位知识库）', xml.includes('1E7B34')],
    ['红色 C0392B（其他）', xml.includes('C0392B')],
  ];
  checks.forEach(([n, p]) => console.log(`  ${p ? 'PASS' : 'FAIL'}  ${n}`));
  console.log('\n来源分布表片段:');
  const idx = xml.indexOf('回答来源分布');
  if (idx >= 0) {
    const seg = xml.slice(idx, idx + 2500).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log('  ' + seg.slice(0, 300));
  }
  process.exit(0);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
