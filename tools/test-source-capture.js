/**
 * 验证引擎现在能抓到「来源」：对真实站点跑 1 题，看 source / attribution
 * 用法: node tools/test-source-capture.js
 */
const path = require('path');
const CFG = require('../lib/config');
const { RobotRunner } = require('../lib/robot');

const URL_ = 'https://robot.chaoxing.com/coze/web?accessToken=xxx&unitId=xxx&robotId=xxx';

(async () => {
  const runner = new RobotRunner({
    url: URL_,
    questions: ['图书馆的开放时间是怎样安排的？'],
    shotsDir: path.join(CFG.DATA_DIR, 'shots', 'srctest'),
    answerTimeoutSec: 120,
  });

  runner.on('progress', p => {
    if (p.message) console.log(`  [${p.phase}] ${p.message}`);
  });

  try {
    const results = await runner.run();
    const r = results[0] || {};
    console.log('\n===== 抓取结果 =====');
    console.log('completed   :', r.completed);
    console.log('attribution :', JSON.stringify(r.attribution));
    console.log('recall      :', JSON.stringify(r.recall));
    console.log('recallTitles:', JSON.stringify(r.recallTitles));
    console.log('source      :', JSON.stringify(r.source));
    console.log('answer 前 120:', JSON.stringify((r.answer || '').slice(0, 120)));

    const ok = !!(r.source && r.source.category);
    console.log('\n来源是否抓到:', ok ? 'PASS (' + r.source.category + ' / ' + r.source.label + ')' : 'FAIL');
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    console.log('运行失败: ' + e.message);
    process.exitCode = 1;
  }
})();
