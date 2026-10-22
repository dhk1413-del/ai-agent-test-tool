/**
 * 验证「开始本轮测试」可达性（适配窄屏顶栏按钮 / 宽屏头部按钮）
 * 用法: node tools/verify-run-btn.js [W] [H]
 */
const puppeteer = require('puppeteer-core');
const path = require('path');

const W = Number(process.argv[2] || 945);
const H = Number(process.argv[3] || 592);

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333', defaultViewport: null, protocolTimeout: 180000 });
  const page = await browser.newPage();
  try {
    await page.setCacheEnabled(false);
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:3789/?f=${Date.now()}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 1400));

    // 找出当前真实可见的运行入口
    const entry = () => {
      const vh = window.innerHeight;
      const cand = [
        ['顶栏', document.querySelector('.mobile-run')],
        ['头部', document.querySelector('.hdr-run')],
        ['卡片底部', document.querySelector('.config-foot [data-act="start-run"]')],
      ];
      for (const [name, el] of cand) {
        if (!el) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || el.offsetParent === null) continue;
        const b = el.getBoundingClientRect();
        if (b.width > 0 && b.height > 0 && b.top >= 0 && b.bottom <= vh && b.bottom > 0) {
          return { name, top: Math.round(b.top), bottom: Math.round(b.bottom), w: Math.round(b.width) };
        }
      }
      return null;
    };

    const scroller = await page.evaluate(() => {
      const m = document.querySelector('.main');
      return (m.scrollHeight - m.clientHeight > 10 && getComputedStyle(m).overflowY !== 'visible') ? 'main' : 'document';
    });
    console.log(`=== ${W}x${H} (滚动: ${scroller}) ===`);

    const rows = [];
    for (const f of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      await page.evaluate(async (fr, sc) => {
        if (sc === 'main') {
          const m = document.querySelector('.main');
          m.scrollTop = Math.round((m.scrollHeight - m.clientHeight) * fr);
        } else {
          window.scrollTo(0, Math.round((document.documentElement.scrollHeight - window.innerHeight) * fr));
        }
        await new Promise(r => setTimeout(r, 260));
      }, f, scroller);
      const e = await page.evaluate(entry);
      rows.push({ f, visible: e ? e.name : 'NONE', top: e ? e.top : null });
    }
    rows.forEach(r => console.log('  ' + JSON.stringify(r)));
    console.log('全程至少一个可见入口:', rows.every(r => r.visible !== 'NONE') ? 'PASS' : 'FAIL');

    // 空状态按钮 -> 是否把用户带到可点入口
    await page.evaluate((sc) => {
      if (sc === 'main') document.querySelector('.main').scrollTop = 0;
      else window.scrollTo(0, 0);
    }, scroller);
    await new Promise(r => setTimeout(r, 300));
    await page.click('[data-act="focus-run"]');
    await new Promise(r => setTimeout(r, 1500));
    const after = await page.evaluate(entry);
    console.log('点击空状态按钮后可见入口:', after ? JSON.stringify(after) : 'NONE');
    console.log('空状态按钮有效:', after ? 'PASS' : 'FAIL');

    const out = path.join(__dirname, '..', 'data', 'logs', `verify-${W}x${H}.png`);
    await page.screenshot({ path: out });
    console.log('screenshot ->', out);
  } finally {
    await page.close();
    await browser.disconnect();
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
