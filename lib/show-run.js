const B = process.argv[3] || 'http://127.0.0.1:3789';
const rid = process.argv[2];
(async () => {
  const d = await (await fetch(`${B}/api/runs/${rid}`)).json();
  console.log(`状态=${d.status}  成功=${d.okCount}/${d.total}  平均=${d.avgSec}s  引擎=${JSON.stringify(d.engine && d.engine.notes)}`);
  console.log('─'.repeat(100));
  (d.results || []).forEach(x => {
    const ans = (x.answer || '').replace(/\s+/g, ' ');
    console.log(`Q${String(x.index).padStart(2)} | ${String(x.elapsedSec == null ? '-' : x.elapsedSec + 's').padStart(5)} | ${String(x.card ? '卡片' : (x.answer || '').length + '字').padStart(6)} | ok=${x.completed ? 'Y' : 'N'} | shot=${x.hasScreenshot ? 'Y' : 'N'}`);
    console.log(`     ${ans.slice(0, 150) || '(无文字回答)'}`);
    if (x.error) console.log(`     ⚠ ${x.error}`);
  });
})();
