/**
 * 诊断脚本：检查「开始本轮测试」按钮的位置与可见性
 * 用法： node tools/inspect-run-btn.js [viewportWidth] [viewportHeight]
 */
const puppeteer = require('puppeteer-core');

const W = Number(process.argv[2] || 945);
const H = Number(process.argv[3] || 592);
const APP = 'http://127.0.0.1:3789/';

(async () => {
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9333',
    defaultViewport: null,
    protocolTimeout: 120000,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await page.goto(APP, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 1200));

  const info = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const btn = q('#btn-run');
    const layout = q('.project-layout');
    const rightCol = q('.pl-right');
    const main = q('.main');
    const r = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        rect: { top: Math.round(b.top), left: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height) },
        display: cs.display, visibility: cs.visibility, overflow: cs.overflowX,
      };
    };
    // 按钮是否在视口内
    let btnVisible = null;
    if (btn) {
      const b = btn.getBoundingClientRect();
      btnVisible = {
        inViewportX: b.left >= 0 && b.right <= window.innerWidth,
        inViewportY: b.top >= 0 && b.bottom <= window.innerHeight,
        offsetParentNull: btn.offsetParent === null,
        hiddenByClass: btn.classList.contains('hidden'),
      };
    }
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      sidebarW: q('.sidebar') ? Math.round(q('.sidebar').getBoundingClientRect().width) : null,
      main: r(main),
      layout: r(layout),
      layoutTemplate: layout ? getComputedStyle(layout).gridTemplateColumns : null,
      rightCol: r(rightCol),
      runBtn: r(btn),
      btnVisible,
      documentScrollW: document.documentElement.scrollWidth,
      documentClientW: document.documentElement.clientWidth,
      mediaQuery1180: window.matchMedia('(max-width: 1180px)').matches,
    };
  });

  console.log(JSON.stringify(info, null, 2));

  // 截取当前视口，便于直观确认
  const out = require('path').join(__dirname, '..', 'data', 'logs', `layout-${W}x${H}.png`);
  await page.screenshot({ path: out });
  console.log('screenshot ->', out);

  await page.close();
  await browser.disconnect();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
