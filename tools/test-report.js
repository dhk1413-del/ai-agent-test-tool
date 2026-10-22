/**
 * 生成报告并做结构检查：
 *  - 单轮报告：确认每题块内「截图 → 问答 → 来源」顺序，且不再有独立附录
 *  - 汇总报告：确认最新一轮同样带截图与来源
 * 文档 XML 里可以直接验证顺序与颜色。
 * 用法: node tools/test-report.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const CFG = require('../lib/config');
const store = require('../lib/store');
const { buildRunReport, buildProjectReport } = require('../lib/report');

const OUT = path.join(__dirname, '.tmp');   // 测试产物放 tools/.tmp，不污染 data/
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

/** 解出 docx 里的 word/document.xml */
function docXml(buf) {
  const tmp = path.join(OUT, '_tmp.docx');
  fs.writeFileSync(tmp, buf);
  // docx 是 zip：从本地文件做起，用内置 zlib 手动解析太麻烦，直接调 docx 之外的办法
  // 这里用 Node 的 zlib 解析 zip 条目（stored/deflate 两种）
  const data = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
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
  const db = store.readDb();
  const byProject = {};
  db.runs.forEach(r => { (byProject[r.projectId] = byProject[r.projectId] || []).push(r); });

  const pid = Object.keys(byProject).sort((a, b) =>
    (byProject[b][0].total || 0) - (byProject[a][0].total || 0))[0];
  if (!pid) { console.log('没有可用的测试数据'); process.exit(0); }
  const project = store.getProject(pid);
  const runs = store.listRuns(pid).map(r => store.getRun(r.id)).filter(Boolean);
  const run = runs[0];
  console.log(`项目「${project.name}」第 ${run.index} 轮，${(run.results || []).length} 题\n`);

  // ---- 单轮报告 ----
  const runBuf = await buildRunReport({
    project, run, shotsDir: path.join(CFG.SHOTS_DIR, run.id),
  });
  const runPath = path.join(OUT, 'test-run-report.docx');
  fs.writeFileSync(runPath, runBuf);
  console.log(`单轮报告: ${runPath}  (${(runBuf.length / 1024).toFixed(0)} KB)`);

  const xml = docXml(runBuf);
  check('文档可解析', xml.length > 1000, `${xml.length} 字符`);
  check('不再有「附录：各题页面截图」', !xml.includes('附录：各题页面截图'));
  check('章节改为「四、逐题问答详情（含页面截图）」', xml.includes('逐题问答详情（含页面截图）'));
  check('含「回答来源分布」', xml.includes('回答来源分布'));
  check('结果分析已改为「五、」', xml.includes('五、结果分析'));

  // 每题块内顺序：截图 → 提问 → 来源（只看「逐题问答详情」这一节，避免命中表头里的“提问”）
  const secStart = xml.indexOf('逐题问答详情（含页面截图）');
  const secXml = secStart >= 0 ? xml.slice(secStart) : '';
  const idxShot = secXml.indexOf('页面截图：');
  const idxAsk = secXml.indexOf('提问');
  const idxSrc = secXml.indexOf('该答案来自：');
  const idxAns = secXml.indexOf('AI 回答：');
  check('逐题详情节内：截图在最前（截图 < 提问）', idxShot >= 0 && idxAsk > idxShot, `截图@${idxShot} 提问@${idxAsk}`);
  check('逐题详情节内：提问 < 回答', idxAsk >= 0 && idxAns > idxAsk, `提问@${idxAsk} 回答@${idxAns}`);
  check('逐题详情节内：回答 < 来源', idxAns >= 0 && idxSrc > idxAns, `回答@${idxAns} 来源@${idxSrc}`);

  // 颜色检查：三种颜色值应出现在文档里
  const hasBlue = xml.includes('1A56DB');
  const hasGreen = xml.includes('1E7B34');
  const hasRed = xml.includes('C0392B');
  check('存在蓝色（问答库）色值 1A56DB', hasBlue);
  check('存在绿色（单位知识库）色值 1E7B34', hasGreen, '（需有 unit 类样本）');
  check('存在红色（其他）色值 C0392B', hasRed, '（需有 other 类样本）');

  // 来源分布统计
  const s = require('../lib/report');
  const cnt = { qa: 0, unit: 0, other: 0 };
  (run.results || []).forEach(r => {
    const x = r.source && r.source.category ? r.source.category : null;
    if (x) cnt[x]++; else cnt.__nokind = (cnt.__nokind || 0) + 1;
  });
  console.log('  （本轮数据自带 source 的分布：' + JSON.stringify(cnt) + '）');

  // ---- 汇总报告 ----
  const projBuf = await buildProjectReport({
    project, runs, shotsDirOf: (rid) => path.join(CFG.SHOTS_DIR, rid),
  });
  const projPath = path.join(OUT, 'test-project-report.docx');
  fs.writeFileSync(projPath, projBuf);
  console.log(`\n汇总报告: ${projPath}  (${(projBuf.length / 1024).toFixed(0)} KB)`);
  const pxml = docXml(projBuf);
  check('汇总报告可解析', pxml.length > 1000, `${pxml.length} 字符`);
  check('汇总报告含来源列', pxml.includes('回答来源'));
  check('汇总报告最新一轮含截图', pxml.includes('页面截图：'));
  check('汇总报告最新一轮含来源行', pxml.includes('该答案来自：'));

  const failed = results.filter(r => !r.pass);
  console.log(`\n===== 汇总: ${results.length - failed.length}/${results.length} PASS =====`);
  failed.forEach(f => console.log('  FAILED: ' + f.name + ' — ' + (f.detail || '')));
  process.exitCode = failed.length ? 1 : 0;
})().catch(e => { console.error('FAILED: ' + e.message); console.error(e.stack); process.exit(1); });
