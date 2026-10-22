/**
 * 通用 AI 问答机器人自动化引擎
 *  - 自动探测输入框 / 发送按钮 / 新建对话按钮（不依赖单一站点）
 *  - 支持文字型与卡片型两种回答形态
 *  - 遇到页面异常（403、元素消失、超时）自动重建会话并重试
 */
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const CFG = require('./config');
const chrome = require('./chrome');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 页面内执行的探测脚本
 * ------------------------------------------------------------------ */
/* 不修改页面 DOM：只计算元素的 CSS 路径，交由 puppeteer 重新定位，
   避免给 Vue/React 控制的节点加属性而触发重渲染、把已输入内容冲掉。 */
function DETECT_SPEC() {
  const vis = el => {
    try {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    } catch { return false; }
  };
  const cssPath = el => {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      const parent = cur.parentElement;
      if (!parent) break;
      const idx = Array.from(parent.children).indexOf(cur) + 1;
      parts.unshift(cur.tagName.toLowerCase() + ':nth-child(' + idx + ')');
      cur = parent;
    }
    return parts.length ? 'body > ' + parts.join(' > ') : null;
  };
  const res = { inputSel: null, sendSel: null, newConvSel: null, notes: [] };

  // ---- 输入框：取最靠下、宽度足够的可见可编辑区域 ----
  const cands = [];
  for (const s of ['.input-body.ProseMirror', '[contenteditable="true"]', 'textarea', 'input[type="text"]', 'input:not([type])']) {
    for (const el of document.querySelectorAll(s)) {
      if (!vis(el)) continue;
      if (el.tagName === 'INPUT' && ['checkbox', 'radio', 'hidden', 'file', 'submit', 'button', 'search'].includes(el.type)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 120 || r.height > 400) continue;
      // 排除只读/禁用
      if (el.disabled || el.readOnly || el.getAttribute('contenteditable') === 'false') continue;
      cands.push({ el, s, bottom: r.bottom });
    }
  }
  cands.sort((a, b) => b.bottom - a.bottom);
  if (cands.length) {
    res.inputSel = cssPath(cands[0].el);
    res.notes.push('input=' + cands[0].s);
  }

  // ---- 发送按钮 ----
  let sendEl = null;
  for (const s of ['.send-button', 'button[class*="send" i]', '[class*="send-btn" i]', '[class*="sendBtn"]']) {
    const el = Array.from(document.querySelectorAll(s)).find(vis);
    if (el) { sendEl = el; res.notes.push('send=' + s); break; }
  }
  if (!sendEl) {
    const t = Array.from(document.querySelectorAll('button, div, span, a'))
      .filter(e => vis(e) && /^(发送|提交|Send|Ask|提问)$/i.test((e.innerText || '').trim()));
    if (t.length) { sendEl = t[t.length - 1]; res.notes.push('send=text'); }
  }
  if (sendEl) res.sendSel = cssPath(sendEl);

  // ---- 新建对话 ----
  let ncEl = null;
  for (const s of ['.add-conversation', '[class*="add-conversation"]', '[class*="new-conversation"]',
    '[class*="newConversation"]', '[class*="new-chat"]', '[class*="newChat"]',
    '[class*="create-conversation"]', '[class*="createChat"]', '[class*="newSession"]']) {
    const el = Array.from(document.querySelectorAll(s)).find(vis);
    if (el) { ncEl = el; res.notes.push('newConv=' + s); break; }
  }
  if (!ncEl) {
    const t = Array.from(document.querySelectorAll('button, div, span, a'))
      .filter(e => vis(e) && /^(新建对话|新对话|新建会话|开启新对话|新会话|New chat)$/i.test((e.innerText || '').trim()));
    if (t.length) { ncEl = t[0]; res.notes.push('newConv=text'); }
  }
  if (ncEl) res.newConvSel = cssPath(ncEl);

  return res;
}

/* 读取当前对话状态；q 为用户提问原文（兜底定位用） */
function READ_SPEC(q) {
  const out = {
    mode: 'none', text: '', extra: '', answer: '', flow: '', running: false,
    pfDone: true, hasCard: false, attribution: '', recall: '', recallTitles: [], url: location.href,
  };
  const strip = t => String(t || '')
    .replace(/^\s*运行完成\s*(展开|收起)?\s*/, '')
    .replace(/\s*重新回答\s*$/, '')
    .trim();

  // ---- 主路径：coze / 超星 结构 ----
  const lefts = Array.from(document.querySelectorAll('.message-avatar.left'));
  if (lefts.length) {
    out.mode = 'coze';
    const last = lefts[lefts.length - 1];
    const raw = last.innerText || '';

    // 先单独取出「扩展区/资源推荐」内容（卡片可能在这里）
    const ext = last.querySelector('.message-extension, .user-ask-recommend');
    const extText = ext ? (ext.innerText || '').trim() : '';

    // 正文：剔除过程条、操作条、扩展区、PPT 等界面元素
    const clone = last.cloneNode(true);
    clone.querySelectorAll(
      '.process-flow, .message-actions, .message-extension, .user-ask-recommend, ' +
      '[class*="ppt" i], [class*="toolbar" i]'
    ).forEach(e => e.remove());
    // 给块级元素补上换行，使 textContent 也保留段落结构
    try {
      clone.querySelectorAll('br').forEach(b => b.replaceWith(document.createTextNode('\n')));
      clone.querySelectorAll('div,p,li,h1,h2,h3,h4,h5,h6,tr,section,pre').forEach(e => {
        try { e.appendChild(document.createTextNode('\n')); } catch { }
      });
    } catch { }

    const innerTxt = (clone.innerText || '').trim();
    const textC = (clone.textContent || '').trim();
    // 该站点对离屏内容做懒渲染，innerText 可能只拿到首行；textContent 更完整
    let text = (textC.length > innerTxt.length * 1.25) ? textC : (innerTxt || textC);
    text = strip(text);
    // 兜底清理残留界面文字
    text = text.replace(/选择模板[\s\S]*$/, '').replace(/更多资源推荐[\s\S]*$/, '').trim();
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    // ---- 来源信息（必须在剥离 .message-actions 之前从原始 DOM 取）----
    // 站点结构：<span class="origin-text">该答案由AI大模型总结生成，内容来自：单位AI知识库</span>
    // 它位于 .message-actions 内，而下面会把 .message-actions 整个移除，
    // 所以只能在这里先读出来，否则永远拿不到来源。
    const originEl = last.querySelector('.origin-text, [class*="origin-text"]');
    if (originEl) out.attribution = (originEl.innerText || originEl.textContent || '').trim();

    // 过程流里的召回标题（如「知识库召回完成」「问答库召回完成」）
    const titles = Array.from(last.querySelectorAll('.process-flow__title'))
      .map(e => (e.innerText || '').trim()).filter(Boolean);
    out.recallTitles = titles;
    const recall = titles.filter(t => /召回|命中|匹配/.test(t));
    if (recall.length) out.recall = recall[recall.length - 1];

    // 兜底：若页面没有 origin-text，再从整块文本里找署名行
    if (!out.attribution) {
      const am = raw.match(/该答案(?:由|来自)[^\n]{0,80}/);
      if (am) out.attribution = am[0].trim();
    }

    const pfEl = last.querySelector('.process-flow');
    out.flow = pfEl ? (pfEl.innerText || '').replace(/\s+/g, ' ').trim() : '';
    out.running = /停止思考|思考中|正在问题理解|正在生成|正在检索|运行中/.test(raw);
    out.pfDone = !out.flow || /运行完成|收起/.test(out.flow);
    // 「重新回答」操作区只在回答真正结束后才出现，是最可靠的结束信号
    out.actions = !!last.querySelector('.message-actions') || /重新回答/.test(raw);

    // 若前面没从 DOM 直接读到署名，再从正文里兜底抽一次
    if (!out.attribution) {
      const m = text.match(/该答案由[\s\S]{0,80}?(生成|总结生成)[^\n]*/);
      if (m) { out.attribution = m[0].trim(); }
    }
    // 正文里如果混进了这行署名，去掉它，避免和报告里的「来源」重复
    text = text.replace(/该答案(?:由|来自)[^\n]{0,80}/g, '').trim();

    // 卡片判定：有卡片类容器，或正文为空但整块有内容
    const bc = last.querySelector('.message-body-content');
    const bcEmpty = bc ? !(bc.innerText || '').trim() : true;
    out.hasCard = !!last.querySelector('[class*="card" i], iframe, [class*="activity"], [class*="widget"], [class*="plugin" i]')
      || (bcEmpty && !!(extText || text));

    out.text = text;
    out.extra = extText;
    out.answer = text || extText;
    return out;
  }

  // ---- 兜底路径：通用 DOM 结构 ----
  if (!q) return out;
  const all = Array.from(document.querySelectorAll('div, p, li, section, article'));
  let bubble = null;
  for (const el of all) {
    const t = el.innerText || '';
    if (!t.includes(q)) continue;
    const childHas = Array.from(el.children).some(c => (c.innerText || '').includes(q));
    if (!childHas) { bubble = el; break; }
  }
  if (!bubble) return out;
  let container = bubble;
  for (let i = 0; i < 8 && container.parentElement; i++) {
    container = container.parentElement;
    const t = container.innerText || '';
    if (container.children.length >= 2 && t.length > q.length + 10) break;
  }
  const full = (container.innerText || '').trim();
  const pos = full.lastIndexOf(q);
  out.mode = 'generic';
  out.text = pos >= 0 ? full.slice(pos + q.length).trim() : full;
  out.answer = out.text;
  out.hasCard = !!container.querySelector('iframe, [class*="card" i]');
  out.running = false;
  return out;
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */
async function pickFrame(page) {
  for (const f of page.frames()) {
    try {
      const hit = await f.evaluate(() =>
        !!document.querySelector('.message-avatar.left') ||
        !!document.querySelector('.input-body.ProseMirror') ||
        !!document.querySelector('[contenteditable="true"]') ||
        !!document.querySelector('textarea'));
      if (hit) return f;
    } catch { }
  }
  return page.mainFrame();
}

async function clickSel(page, frame, sel, label) {
  if (!sel) throw new Error(`未找到「${label}」元素`);
  const el = await frame.$(sel);
  if (!el) throw new Error(`「${label}」元素已失效`);
  const box = await el.boundingBox();
  if (!box || box.width < 2 || box.height < 2) throw new Error(`「${label}」元素不可见`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return true;
}

/* ------------------------------------------------------------------ *
 * 来源判定
 *   依据页面上的「署名行」(.origin-text) 与过程流里的召回标题，
 *   归类成三种，供报告着色：
 *     qa    问答库      （蓝）
 *     unit  单位知识库  （绿）
 *     other 其他        （红）
 *   站点实际文案示例：
 *     该答案由AI大模型总结生成，内容来自：单位AI知识库
 *     该答案由AI大模型总结生成，内容来自：问答库
 *     该答案由AI大模型生成            ← 没有检索到任何库
 * ------------------------------------------------------------------ */

/** 关键字 → 类别（顺序即优先级） */
const SOURCE_RULES = [
  { cat: 'qa', re: /问答库|常见问题库|FAQ库|faq\s*库|问答知识库/i },
  { cat: 'unit', re: /单位\s*AI\s*知识库|单位知识库|机构知识库|本校知识库|知识库/i },
];

/** 从署名行里取出「内容来自：X」的 X；没有明确来源时返回空串 */
function extractSourceLabel(attribution) {
  const t = String(attribution || '').trim();
  if (!t) return '';
  const m = t.match(/内容来自[：:]\s*([^\n，。;；]+)/) || t.match(/来自[：:]\s*([^\n，。;；]+)/);
  return m ? m[1].trim() : '';
}

/**
 * 判定来源。
 * @param {object} info 至少包含 attribution / recallTitles / recall / answer
 * @returns {{category:'qa'|'unit'|'other', label:string, raw:string, reason:string}}
 */
function deriveSource(info = {}) {
  const attribution = String(info.attribution || '').trim();
  const recallTitles = Array.isArray(info.recallTitles) ? info.recallTitles.join(' ') : '';
  const recall = String(info.recall || '');
  const answer = String(info.answer || '');

  // 只有「确实召回了某个库」才算命中来源；
  // 单纯一句「该答案由AI大模型生成」说明没有检索到库，归为「其他」。
  const positive = /召回|命中|匹配/.test(recall || recallTitles);
  const text = attribution;

  if (positive || text) {
    const hay = text || (recallTitles + ' ' + recall);
    for (const rule of SOURCE_RULES) {
      if (rule.re.test(hay)) {
        // 有「内容来自：X」就用 X；只有召回标题时用类别默认名
        const label = extractSourceLabel(text) || (rule.cat === 'qa' ? '问答库' : '单位知识库');
        return { category: rule.cat, label, raw: text || recall, reason: '署名或召回命中' };
      }
    }
  }

  // 再退一步：回答正文自称来自某库
  for (const rule of SOURCE_RULES) {
    if (rule.re.test(answer)) {
      const label = extractSourceLabel(attribution) || (rule.cat === 'qa' ? '问答库' : '单位知识库');
      return { category: rule.cat, label, raw: attribution, reason: '回答正文命中' };
    }
  }

  return {
    category: 'other',
    label: extractSourceLabel(attribution),
    raw: attribution,
    reason: positive ? '有召回但未识别出库类型' : '未检索到知识库',
  };
}

/** 类别 → 报告用颜色（蓝 / 绿 / 红） */
const SOURCE_COLORS = { qa: '1A56DB', unit: '1E7B34', other: 'C0392B' };
const SOURCE_NAMES = { qa: '问答库', unit: '单位知识库', other: '其他' };

/* ------------------------------------------------------------------ *
 * 运行器
 * ------------------------------------------------------------------ */
class RobotRunner extends EventEmitter {
  constructor({ url, questions, shotsDir, answerTimeoutSec = CFG.ANSWER_TIMEOUT_SEC }) {
    super();
    this.url = url;
    this.questions = questions;
    this.shotsDir = shotsDir;
    this.answerTimeoutSec = answerTimeoutSec;
    this.engineInfo = null;
    this.cancelled = false;
    this.paused = false;
    this._pauseWaiters = [];
    fs.mkdirSync(shotsDir, { recursive: true });
  }

  cancel() { this.cancelled = true; this._releasePause(); }

  /** 暂停：在「题目之间」的安全点生效，不会打断正在进行的问答 */
  pause() { if (!this.cancelled) this.paused = true; }
  resume() { this.paused = false; this._releasePause(); }
  _releasePause() {
    const ws = this._pauseWaiters;
    this._pauseWaiters = [];
    ws.forEach(w => { try { w(); } catch { } });
  }

  /** 可中断的休眠：暂停或取消时立即返回 */
  _sleepInterruptible(ms) {
    if (this.cancelled || this.paused) return Promise.resolve();
    return new Promise(resolve => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(finish, ms);
      this._pauseWaiters.push(finish);
    });
  }

  /** 在安全点等待：若处于暂停状态则阻塞，直到 resume() 或 cancel() */
  async _pauseGate(progressInfo) {
    if (this.cancelled) return;
    if (this.paused) {
      if (progressInfo) {
        this.progress(progressInfo.current, progressInfo.total, progressInfo.question, 'paused', '已暂停（将在当前题目完成后停止）');
      }
      await new Promise(resolve => this._pauseWaiters.push(resolve));
    }
    if (!this.cancelled && progressInfo && progressInfo.resumeMessage) {
      this.progress(progressInfo.current, progressInfo.total, progressInfo.question, 'typing', progressInfo.resumeMessage);
    }
  }

  progress(current, total, question, phase, message) {
    this.emit('progress', { current, total, question, phase, message });
  }

  async loadPage(browser) {
    if (this.ctx) { try { await this.ctx.close(); } catch { } }
    this.ctx = await browser.createBrowserContext();
    this.page = await this.ctx.newPage();
    await this.page.setViewport(CFG.VIEWPORT);
    await this.page.setUserAgent(CFG.UA);
    await this.page.evaluateOnNewDocument(() => {
      try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch { }
    });
    await this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 120000 });

    // 追踪「对话流」请求：流式回答在网络上真正结束，是最可靠的完成信号
    this.inflight = 0;
    const interesting = u => /(\/chat\/|conversation|completion|\/stream|\/sse|generate|answer|llm)/i.test(u)
      && !/\.(png|jpe?g|gif|webp|css|js|woff2?|svg|ico)(\?|$)/i.test(u);
    this.page.on('request', r => {
      if (!interesting(r.url())) return;
      r.__aitestBusy = true;
      this.inflight++;
    });
    const dec = r => { if (r.__aitestBusy) { r.__aitestBusy = false; this.inflight = Math.max(0, this.inflight - 1); } };
    this.page.on('requestfinished', dec);
    this.page.on('requestfailed', dec);

    for (let i = 0; i < 45; i++) {
      await sleep(1000);
      this.frame = await pickFrame(this.page);
      let hasInput = false;
      try {
        hasInput = await this.frame.evaluate(() =>
          !!document.querySelector('.input-body.ProseMirror') ||
          !!document.querySelector('[contenteditable="true"]') ||
          !!document.querySelector('textarea'));
      } catch { }
      if (hasInput) break;
    }
    await sleep(3500);
    await this.detect();
    return this.page;
  }

  async detect() {
    this.frame = await pickFrame(this.page);
    const info = await this.frame.evaluate(DETECT_SPEC);
    this.sel = info;
    this.engineInfo = {
      inputSelector: info.inputSel, sendSelector: info.sendSel,
      newConvSelector: info.newConvSel, notes: info.notes, mode: 'auto',
    };
    return info;
  }

  async healthy() {
    if (!this.page || this.page.isClosed()) return false;
    if (this.page.url().includes('/403') || /403 Forbidden/i.test(await this.page.title().catch(() => ''))) return false;
    try {
      return await this.frame.evaluate(() =>
        !!document.querySelector('.input-body.ProseMirror') ||
        !!document.querySelector('[contenteditable="true"]') ||
        !!document.querySelector('textarea'));
    } catch { return false; }
  }

  async ask(browser, index, question) {
    const total = this.questions.length;
    let lastErr = null;

    for (let attempt = 1; attempt <= CFG.MAX_ATTEMPTS; attempt++) {
      try {
        if (!(await this.healthy())) {
          this.progress(index, total, question, 'loading', attempt > 1 ? '页面异常，正在重建会话…' : '加载页面中…');
          await this.loadPage(browser);
        }

        // 1) 新建对话
        this.progress(index, total, question, 'newConversation', '新建对话中…');
        await this.detect();
        if (this.sel.newConvSel) {
          try { await clickSel(this.page, this.frame, this.sel.newConvSel, '新建对话'); } catch (e) { /* 可选步骤 */ }
          await sleep(2600);
          await this.detect();
        }

        // 2) 输入问题（坐标点击可能因浮层/重渲染而失焦，故主动 focus + 校验 + 重试）
        this.progress(index, total, question, 'typing', '输入问题中…');
        await this.detect();
        let typedOk = false, diag = '';
        for (let t = 1; t <= 3 && !typedOk; t++) {
          try { await clickSel(this.page, this.frame, this.sel.inputSel, '输入框'); } catch { }
          await sleep(320);
          const foc = await this.focusInput();
          await sleep(220);
          // 只有在确有残留文本时才清空。
          // 注意：在干净的 ProseMirror 编辑框上按 Ctrl+A / Backspace 会让其内部状态与 DOM 失步，
          // 导致发送按钮保持 disabled、点击无效（首题必失败的根因）。
          const pre = await this.readInput();
          if (pre.trim()) {
            try {
              await this.page.keyboard.down('Control');
              await this.page.keyboard.press('KeyA');
              await this.page.keyboard.up('Control');
              await this.page.keyboard.press('Backspace');
              await sleep(200);
            } catch { }
          }
          await this.page.keyboard.type(question, { delay: 30 });
          await sleep(900);
          const cur = await this.readInput();
          if (cur.trim()) {
            // 确认发送按钮已可用，否则用一次无害按键促使编辑器同步内部状态
            const enabled = await this.frame.evaluate(() => {
              const btn = document.querySelector('.send-button');
              return btn ? !btn.disabled : null;
            });
            if (enabled === false) {
              try { await this.page.keyboard.press('End'); } catch { }
              await sleep(400);
            }
            typedOk = true;
            break;
          }
          diag = await this.inputDiag(foc);
          await this.detect();
          await sleep(600);
        }
        if (!typedOk) throw new Error('输入未生效' + (diag ? '（' + diag + '）' : ''));

        // 3) 发送
        //    优先用 JS 原生 click()：真实鼠标按下会让编辑框失焦，部分站点会因此读到未同步的
        //    编辑器状态而忽略本次发送（表现为按钮可点、文案正常，但输入框内容不被消费）。
        const sentAt = new Date();
        let sent = false;
        for (let s = 1; s <= 3 && !sent; s++) {
          await this.detect();

          // 方式一：JS 原生 click
          try {
            if (this.sel.sendSel) {
              const hit = await this.frame.evaluate(sel => {
                const el = document.querySelector(sel);
                if (!el) return false;
                el.click();
                return true;
              }, this.sel.sendSel);
              if (!hit) await this.page.keyboard.press('Enter');
            } else {
              await this.page.keyboard.press('Enter');
            }
          } catch { }
          await sleep(1800);
          if (await this.hasAnyUserMsg()) { sent = true; break; }

          // 方式二：回车
          await this.focusInput();
          await sleep(250);
          try { await this.page.keyboard.press('Enter'); } catch { }
          await sleep(1800);
          if (await this.hasAnyUserMsg()) { sent = true; break; }

          // 方式三：真实鼠标点击
          try { if (this.sel.sendSel) await clickSel(this.page, this.frame, this.sel.sendSel, '发送按钮'); } catch { }
          await sleep(1800);
          if (await this.hasAnyUserMsg()) { sent = true; break; }
        }

        // 等待用户消息上屏，确认发送成功
        let confirmed = false;
        for (let i = 0; i < 15; i++) {
          const st = await this.read(question);
          if (st.mode === 'coze' ? await this.hasUserMsg() : st.text.length > 0) { confirmed = true; break; }
          await sleep(1000);
        }
        if (!confirmed) throw new Error('发送后未确认到用户消息' + (await this.sendDiag()));

        // 4) 等待回答
        const start = Date.now();
        const ans = await this.waitAnswer(question, start);
        const answeredAt = new Date();

        return {
          index, question,
          answer: ans.answer,
          card: ans.hasCard && !ans.text,
          flow: ans.flow,
          attribution: ans.attribution,
          recall: ans.recall || '',
          recallTitles: ans.recallTitles || [],
          source: deriveSource(ans),
          elapsedSec: Math.round((answeredAt - start) / 1000),
          completed: true,
          note: ans.hasCard && !ans.text ? '该题为卡片型回答（页面以组件卡片而非文字气泡呈现）。' : '',
          sendTime: sentAt.toLocaleString('zh-CN', { hour12: false }),
          answerTime: answeredAt.toLocaleString('zh-CN', { hour12: false }),
          attempts: attempt,
        };
      } catch (e) {
        lastErr = e;
        this.progress(index, total, question, 'waiting', `出现异常，正在重试（${attempt}/${CFG.MAX_ATTEMPTS}）：${String(e.message || e).slice(0, 60)}`);
        try { await this.loadPage(browser); } catch { }
        await sleep(2000);
      }
    }
    throw lastErr || new Error('未知错误');
  }

  async hasUserMsg() {
    try {
      return await this.frame.evaluate(() => document.querySelectorAll('.message-avatar.right, .sent-message').length > 0);
    } catch { return false; }
  }

  async hasAnyUserMsg() {
    try {
      return await this.frame.evaluate(() =>
        document.querySelectorAll('.message-avatar.right, .sent-message, [class*="user-send"], [class*="sent-body"]').length > 0);
    } catch { return false; }
  }

  async readInput() {
    try {
      return await this.frame.evaluate(() => {
        const el = document.querySelector('.input-body.ProseMirror') ||
          document.querySelector('[contenteditable="true"]') ||
          document.querySelector('textarea');
        return el ? (el.innerText || el.value || '') : '';
      });
    } catch { return ''; }
  }

  /* 主动把焦点交给输入框，不依赖坐标点击的命中结果 */
  async focusInput() {
    try {
      return await this.frame.evaluate(() => {
        const el = document.querySelector('.input-body.ProseMirror') ||
          document.querySelector('[contenteditable="true"]') ||
          document.querySelector('textarea');
        if (!el) return false;
        try { el.scrollIntoView({ block: 'center' }); } catch { }
        try { el.focus({ preventScroll: true }); } catch { try { el.focus(); } catch { } }
        try { el.click(); } catch { }
        const a = document.activeElement;
        return !!a && (a === el || el.contains(a));
      });
    } catch { return false; }
  }

  async inputDiag(focused) {
    try {
      return await this.frame.evaluate((f) => {
        const el = document.querySelector('.input-body.ProseMirror');
        const r = el ? el.getBoundingClientRect() : null;
        const a = document.activeElement;
        const top = r ? document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)) : null;
        return `focus方法=${f} 命中元素=${top ? (top.className || top.tagName).toString().slice(0, 40) : 'null'} 当前焦点=${a ? (a.className || a.tagName).toString().slice(0, 40) : 'null'}`;
      }, focused);
    } catch { return ''; }
  }

  /* 发送失败时把现场信息带进错误消息，便于定位 */
  async sendDiag() {
    try {
      const info = await this.frame.evaluate(() => {
        const btn = document.querySelector('.send-button');
        const r = btn ? btn.getBoundingClientRect() : null;
        const at = r ? document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)) : null;
        const inp = document.querySelector('.input-body.ProseMirror');
        return {
          at: at ? (at.className || at.tagName).toString().slice(0, 40) : 'null',
          rest: inp ? (inp.innerText || '').trim().slice(0, 24) : '',
          rights: document.querySelectorAll('.message-avatar.right, .sent-message').length,
          btnTxt: btn ? (btn.innerText || '').trim().slice(0, 10) : '',
          disabled: btn ? !!btn.disabled : null,
        };
      });
      return `（按钮命中=${info.at} 按钮文案="${info.btnTxt}" 按钮禁用=${info.disabled} 输入框残留="${info.rest}" 右侧消息数=${info.rights}）`;
    } catch { return ''; }
  }

  /* 读取当前对话状态；逐帧读取并取“文本最完整”的一份，
     避免帧重复/陈旧帧导致读到尚未渲染完的旧 DOM。 */
  async read(question) {
    const empty = {
      mode: 'none', text: '', extra: '', answer: '', flow: '', running: false,
      pfDone: true, hasCard: false, attribution: '', recall: '', recallTitles: [],
      actions: false, url: this.page.url(),
    };
    const frames = this.page.frames();
    let best = null, bestFrame = null;
    for (const f of frames) {
      try {
        const st = await f.evaluate(READ_SPEC, question);
        const score = (st.answer || '').length + (st.hasCard ? 500 : 0);
        const bestScore = best ? ((best.answer || '').length + (best.hasCard ? 500 : 0)) : -1;
        if (score > bestScore) { best = st; bestFrame = f; }
      } catch { }
    }
    if (best && bestFrame) this.frame = bestFrame;
    return best || empty;
  }

  /* 该站点对离屏内容做懒渲染：读之前先把对话滚到底，促使正文完整进入 DOM */
  async ensureRendered() {
    try {
      await this.frame.evaluate(() => {
        const last = (() => {
          const l = Array.from(document.querySelectorAll('.message-avatar.left'));
          return l[l.length - 1];
        })();
        const scroller = document.querySelector('.message-list-box, .message-list, .message-web-view')
          || (last ? last.parentElement : null);
        if (scroller) { try { scroller.scrollTop = scroller.scrollHeight; } catch { } }
        if (last) { try { last.scrollIntoView({ block: 'end', behavior: 'instant' }); } catch { } }
        try { window.scrollTo(0, document.body.scrollHeight); } catch { }
      });
    } catch { }
  }

  async waitAnswer(question, startMs) {
    let lastSig = '', stable = 0;
    const isPlaceholder = t => !t || /^(思考中|正在思考|正在生成|思考中\.{0,3})$/.test(String(t).trim());
    // 收尾：再滚动一次强制渲染并复读，取更完整的一份（该站点渲染存在延迟）
    const finish = async (st) => {
      await sleep(1000);
      await this.ensureRendered();
      await sleep(800);
      try {
        const s2 = await this.read(question);
        if ((s2.answer || '').length > (st.answer || '').length) return s2;
      } catch { }
      return st;
    };
    for (let i = 1; i <= this.answerTimeoutSec; i++) {
      if (this.cancelled) throw new Error('任务已被取消');
      await sleep(1000);
      if (i % 3 === 0) await this.ensureRendered();
      let st;
      try { st = await this.read(question); } catch { continue; }
      if (st.url && st.url.includes('/403')) throw new Error('页面跳转到 403（访问受限）');

      const text = isPlaceholder(st.answer) ? '' : st.answer;
      const sig = text.length + '|' + text.slice(-80) + '|' + st.hasCard;
      if (sig === lastSig) stable++; else stable = 0;
      lastSig = sig;

      const secs = Math.round((Date.now() - startMs) / 1000);
      this.progress(null, this.questions.length, question, 'waiting', `等待回答中 ${secs}s`);

      // 该站点会先把完整答案取回、再逐字动画渲染，动画中途可能出现数秒停顿，
      // 因此稳定窗口必须足够长（10 秒）才能确认真实结束。
      if (text.length > 0 && !st.running && stable >= 10) return await finish({ ...st, answer: text });
      if (st.hasCard && stable >= 6) return await finish({ ...st, answer: text });
      if (text.length > 0 && stable >= 16) return await finish({ ...st, answer: text });
      if (!st.running && st.pfDone && stable >= 22) return await finish({ ...st, answer: text });
    }
    const st = await this.read(question);
    if ((st.answer || '').length > 0 || st.hasCard) return st;
    throw new Error(`等待回答超时（${this.answerTimeoutSec}s）`);
  }

  async run() {
    const browser = await chrome.connect();
    const results = [];
    this.emit('status', { status: 'running' });

    try {
      this.progress(1, this.questions.length, this.questions[0] || '', 'loading', '加载页面中…');
      await this.loadPage(browser);
      this.emit('engine', this.engineInfo);

      for (let i = 0; i < this.questions.length; i++) {
        const index = i + 1;
        const q = this.questions[i];

        // 暂停校验点：等到用户点「继续」再开始下一题。
        // 放在题目循环开头而不是问答中途，避免打断正在生成的回答。
        await this._pauseGate({
          current: index, total: this.questions.length, question: q,
          resumeMessage: '已继续，准备提问…',
        });
        if (this.cancelled) break;

        this.emit('progress', { current: index, total: this.questions.length, question: q, phase: 'typing', message: '准备提问…' });

        let rec;
        try {
          rec = await this.ask(browser, index, q);
        } catch (e) {
          rec = {
            index, question: q, answer: '', card: false, flow: '', attribution: '',
            elapsedSec: null, completed: false, note: '未取得有效回答',
            error: String(e.message || e).slice(0, 300),
            sendTime: null, answerTime: null,
          };
        }

        // 截图存证
        try {
          const shot = path.join(this.shotsDir, `q${String(index).padStart(2, '0')}.png`);
          await this.page.screenshot({ path: shot });
          rec.hasScreenshot = fs.existsSync(shot);
        } catch { rec.hasScreenshot = false; }

        results.push(rec);
        this.emit('result', rec);
        await this._sleepInterruptible(1200);
      }

      // 被停止：保留已完成的结果并正常返回，交给上层标记为「已停止」
      if (this.cancelled) return results;

      const done = results.filter(r => r.completed);
      const secs = results.map(r => r.elapsedSec).filter(v => typeof v === 'number');
      this.emit('status', {
        status: 'done',
        okCount: done.length,
        total: results.length,
        avgSec: secs.length ? Math.round(secs.reduce((a, b) => a + b, 0) / secs.length) : null,
      });
      return results;
    } catch (e) {
      this.emit('status', { status: 'failed', error: String(e.message || e) });
      throw e;
    } finally {
      this.emit('engine', this.engineInfo);
      try { if (this.ctx) await this.ctx.close(); } catch { }
      try { browser.disconnect(); } catch { }
    }
  }
}

module.exports = {
  RobotRunner, DETECT_SPEC, READ_SPEC,
  deriveSource, extractSourceLabel, SOURCE_COLORS, SOURCE_NAMES,
};
