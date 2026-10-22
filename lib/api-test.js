const B = 'http://127.0.0.1:3789';
const URL0 = 'https://robot.chaoxing.com/coze/web?accessToken=xxx&unitId=xxx&robotId=xxx';
const QS = [
  '图书馆的开放时间是怎样安排的？周末和节假日也开放吗？',
  '借阅图书的期限是多久？可以续借几次？如果逾期会有什么影响？',
  '我想借《平凡的世界》这本书，怎么查询它在馆内的具体架位和索书号？',
  '在校外（校园网以外）如何访问和下载图书馆的电子资源与数据库全文？',
  '图书馆的自习座位需要预约吗？如果要预约，具体怎么操作？',
  '图书如果不小心丢失或者污损了，赔偿标准是怎样的？',
  '图书馆的"馆际互借"和"文献传递"服务怎么申请？大概需要多长时间？',
  '校外人员或者已毕业的校友可以办理借书证吗？需要准备哪些材料？',
  '图书馆最近有哪些读者培训或讲座？我该如何报名参加？',
  '你能不能直接帮我查一下我个人的借阅记录、有没有超期欠款？',
];

const j = async (m, p, body) => {
  const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, d };
};

(async () => {
  const mode = process.argv[2] || 'create';

  if (mode === 'create') {
    const { projects } = (await j('GET', '/api/state')).d;
    for (const p of projects) { await j('DELETE', '/api/projects/' + p.id); console.log('cleared project', p.id); }
    const r = await j('POST', '/api/projects', { name: 'xxx大学图书馆AI馆员', url: URL0, questions: QS });
    console.log('CREATE', r.status, JSON.stringify(r.d).slice(0, 200));
    console.log('PROJECT_ID=' + r.d.id);
  }

  if (mode === 'run') {
    const pid = process.argv[3];
    const r = await j('POST', `/api/projects/${pid}/runs`, {});
    console.log('START RUN', r.status, JSON.stringify(r.d));
    if (r.d && r.d.runId) console.log('RUN_ID=' + r.d.runId);
  }

  if (mode === 'list') {
    const pid = process.argv[3];
    const r = await j('GET', `/api/projects/${pid}`);
    console.log('GET PROJECT', r.status);
    console.log('runs:', JSON.stringify(r.d.runs, null, 1));
  }

  if (mode === 'watch') {
    const rid = process.argv[3];
    for (let i = 0; i < 240; i++) {
      const r = await j('GET', `/api/runs/${rid}`);
      if (r.status !== 200) { console.log('ERR', r.d); return; }
      const d = r.d;
      const done = (d.results || []).length;
      console.log(`[${i}s] status=${d.status} progress=${d.progress ? d.progress.phase + ' ' + (d.progress.message || '') : '-'} results=${done}/${d.total} ok=${d.okCount}${d.error ? ' err=' + d.error : ''}`);
      if (d.status !== 'running') {
        console.log('\n--- RESULTS ---');
        (d.results || []).forEach(x => console.log(`${x.index}. ${x.question.slice(0, 26)} | ${x.elapsedSec}s | ${(x.answer || '').length}字 | card=${!!x.card} | ok=${x.completed} | shot=${x.hasScreenshot} | ${(x.answer || '').slice(0, 60).replace(/\n/g, ' ')}`));
        return;
      }
      await new Promise(r2 => setTimeout(r2, 1000));
    }
  }

  if (mode === 'download') {
    const rid = process.argv[3];
    const r = await fetch(`${B}/api/runs/${rid}/report.docx`);
    console.log('run report status', r.status, 'ctype', r.headers.get('content-type'));
    if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); require('fs').writeFileSync('./download-test.docx', b); console.log('saved download-test.docx', b.length); }
    else console.log(await r.text());
  }
})();
