/**
 * 检查已完成轮次里是否带有「来源」线索：
 *  - attribution（来源署名字段）当前捕获到了什么
 *  - 回答正文里是否出现「问答库 / 知识库 / 该答案来自」等字样
 * 用法: node tools/inspect-sources.js
 */
const path = require('path');
const fs = require('fs');
const CFG = require('../lib/config');

const dbPath = CFG.DB_FILE;
if (!fs.existsSync(dbPath)) { console.log('无 db.json'); process.exit(0); }
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
if (!db.runs.length) { console.log('无轮次'); process.exit(0); }

// 取题量最多的一轮
const target = db.runs.slice().sort((a, b) => (b.total || 0) - (a.total || 0))[0];
const rf = path.join(CFG.RUNS_DIR, target.id + '.json');
if (!fs.existsSync(rf)) { console.log('无轮次数据文件'); process.exit(0); }
const data = JSON.parse(fs.readFileSync(rf, 'utf8'));
const results = data.results || [];

console.log(`轮次 #${target.index}  ${results.length} 题，status=${target.status}\n`);

const withAttr = results.filter(r => (r.attribution || '').trim());
console.log(`有 attribution 的题数: ${withAttr.length}/${results.length}`);
withAttr.slice(0, 6).forEach(r => console.log(`  #${r.index} attribution = ${JSON.stringify(r.attribution)}`));

const withFlow = results.filter(r => (r.flow || '').trim());
console.log(`\n有 flow（检索过程）的题数: ${withFlow.length}/${results.length}`);
withFlow.slice(0, 4).forEach(r => console.log(`  #${r.index} flow = ${JSON.stringify((r.flow || '').slice(0, 160))}`));

const PATTERNS = ['该答案来自', '问答库', '知识库', '来源', '来自', '出处', '引用', '参考'];
console.log('\n关键词命中统计（在回答正文中）:');
for (const kw of PATTERNS) {
  const hit = results.filter(r => (r.answer || '').includes(kw));
  console.log(`  "${kw}": ${hit.length} 题${hit.length ? ' -> #' + hit.slice(0, 8).map(r => r.index).join(',#') : ''}`);
}

// 打印几条完整回答，人工看看来源长什么样
console.log('\n===== 前 3 题完整内容 =====');
results.slice(0, 3).forEach(r => {
  console.log(`\n--- 第 ${r.index} 题 ---`);
  console.log('问: ' + r.question);
  console.log('答: ' + JSON.stringify((r.answer || '').slice(0, 700)));
  console.log('attribution: ' + JSON.stringify(r.attribution || ''));
  console.log('flow: ' + JSON.stringify((r.flow || '').slice(0, 200)));
});
