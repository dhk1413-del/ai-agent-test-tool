/**
 * 用三种来源各一题生成报告，验证 蓝/绿/红 三色与节内顺序
 * 用法: node tools/test-source-colors.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
process.env.DATA_DIR = path.join(ROOT, 'data-reporttest');

const CFG = require('../lib/config');
const { buildRunReport } = require('../lib/report');

function docXml(data) {
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

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  const rows = [
    { index: 1, question: '问答库测试题', answer: '来自问答库的回答内容', completed: true, elapsedSec: 10, card: false,
      attribution: '该答案由AI大模型总结生成，内容来自：问答库', recall: '问答库召回完成',
      source: { category: 'qa', label: '问答库', raw: '该答案由AI大模型总结生成，内容来自：问答库' } },
    { index: 2, question: '知识库测试题', answer: '来自单位知识库的回答内容', completed: true, elapsedSec: 12, card: false,
      attribution: '该答案由AI大模型总结生成，内容来自：单位AI知识库', recall: '知识库召回完成',
      source: { category: 'unit', label: '单位AI知识库', raw: '该答案由AI大模型总结生成，内容来自：单位AI知识库' } },
    { index: 3, question: '无来源测试题', answer: '大模型直接回答的内容', completed: true, elapsedSec: 8, card: false,
      attribution: '该答案由AI大模型生成', recall: '', source: { category: 'other', label: '', raw: '该答案由AI大模型生成' } },
  ];

  const run = {
    id: 'r_color', projectId: 'p', index: 1, status: 'done',
    startedAt: new Date().toISOString(), total: 3, okCount: 3, results: rows,
  };
  const project = { name: '颜色验证', url: 'https://x', questions: rows.map(r => r.question) };

  const buf = await buildRunReport({ project, run, shotsDir: path.join(CFG.SHOTS_DIR, '__none__') });
  const out = path.join(CFG.DATA_DIR, 'color-report.docx');
  fs.writeFileSync(out, buf);
  console.log('报告: ' + out + '\n');

  const xml = docXml(buf);

  // 每处「该答案来自：」后面的颜色
  const marks = [];
  let from = 0;
  for (;;) {
    const i = xml.indexOf('该答案来自：', from);
    if (i < 0) break;
    const seg = xml.slice(i, i + 1500);
    const m = seg.match(/w:color w:val="([0-9A-Fa-f]{6})"/g) || [];
    // 取「该答案来自：」之后紧随的文本与颜色
    const texts = [...seg.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(x => x[1]);
    marks.push({ colors: m.slice(0, 3), text: texts.slice(0, 3).join(' | ') });
    from = i + 5;
  }
  console.log('「该答案来自：」出现次数: ' + marks.length);
  marks.forEach((mk, n) => console.log(`  ${n + 1}. 颜色=${mk.colors.join(',')}  文本=${mk.text}`));

  check('蓝色（问答库）1A56DB 出现', xml.includes('1A56DB'));
  check('绿色（单位知识库）1E7B34 出现', xml.includes('1E7B34'));
  check('红色（其他）C0392B 出现', xml.includes('C0392B'));

  const sec = xml.slice(xml.indexOf('逐题问答详情'));
  const a = sec.indexOf('页面截图：'), b = sec.indexOf('提问'), c = sec.indexOf('AI 回答：'), d = sec.indexOf('该答案来自：');
  check('节内顺序 截图 < 提问 < 回答 < 来源', a >= 0 && b > a && c > b && d > c, `${a} < ${b} < ${c} < ${d}`);
  check('不再有独立「附录：各题页面截图」', !xml.includes('附录：各题页面截图'));
  check('两处来源行颜色不同（蓝/绿）', marks.length >= 2 && marks[0].colors[0] !== marks[1].colors[0],
    marks.length >= 2 ? `${marks[0].colors[0]} vs ${marks[1].colors[0]}` : '');
  const hexes = (arr) => (arr || []).map(x => (x.match(/([0-9A-Fa-f]{6})/) || [])[1]).filter(Boolean).map(s => s.toUpperCase());
  check('三处来源分别为 蓝/绿/红', marks.length >= 3
    && hexes(marks[0].colors).includes('1A56DB')
    && hexes(marks[1].colors).includes('1E7B34')
    && hexes(marks[2].colors).includes('C0392B'),
    marks.slice(0, 3).map(m => hexes(m.colors).join('/')).join('  |  '));

  const failed = results.filter(r => !r.pass);
  console.log(`\n===== 汇总: ${results.length - failed.length}/${results.length} PASS =====`);
  process.exitCode = failed.length ? 1 : 0;
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
