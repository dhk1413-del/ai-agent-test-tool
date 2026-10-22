/* ============================================================
 * AI 机器人问答自动化测试平台 —— 前端逻辑
 * 纯原生 HTML + CSS + JavaScript，零依赖、零构建
 *
 * 接口契约见项目根目录 API.md：
 *   GET    /api/health
 *   GET    /api/state
 *   POST   /api/projects
 *   GET    /api/projects/:pid
 *   PATCH  /api/projects/:pid
 *   DELETE /api/projects/:pid
 *   POST   /api/projects/:pid/runs
 *   GET    /api/runs/:rid
 *   DELETE /api/runs/:rid
 *   GET    /api/runs/:rid/events              (SSE)
 *   GET    /api/runs/:rid/report.docx
 *   GET    /api/projects/:pid/report.docx
 *   GET    /api/runs/:rid/shot/:index
 *   POST   /api/chrome/restart
 * ============================================================ */
'use strict';

/* ------------------------------------------------------------
 * 常量
 * ---------------------------------------------------------- */

var DEFAULT_QUESTIONS = [
  '图书馆的开放时间是怎样安排的？周末和节假日也开放吗？',
  '借阅图书的期限是多久？可以续借几次？如果逾期会有什么影响？',
  '我想借《平凡的世界》这本书，怎么查询它在馆内的具体架位和索书号？',
  '在校外（校园网以外）如何访问和下载图书馆的电子资源与数据库全文？',
  '图书馆的自习座位需要预约吗？如果要预约，具体怎么操作？',
  '图书如果不小心丢失或者污损了，赔偿标准是怎样的？',
  '图书馆的"馆际互借"和"文献传递"服务怎么申请？大概需要多长时间？',
  '校外人员或者已毕业的校友可以办理借书证吗？需要准备哪些材料？',
  '图书馆最近有哪些读者培训或讲座？我该如何报名参加？',
  '你能不能直接帮我查一下我个人的借阅记录、有没有超期欠款？'
];

/* phase → 中文 */
var PHASE_TEXT = {
  loading: '加载页面中',
  newConversation: '新建对话中',
  typing: '输入问题中',
  waiting: '等待回答中',
  paused: '已暂停',
  done: '已完成'
};

/* status → 中文 */
var STATUS_TEXT = {
  running: '进行中',
  paused: '已暂停',
  stopped: '已停止',
  done: '已完成',
  failed: '失败'
};

/* ------------------------------------------------------------
 * 应用状态
 * ---------------------------------------------------------- */

var state = {
  projects: [],
  chrome: 'down',
  bank: null,             // 分类问题库
  ai: null,               // AI 生成配置状态
  pid: null,
  project: null,
  runs: [],
  runId: null,
  run: null,              // 当前关注/展示的 Run 完整数据
  view: 'empty',          // empty | project | run
  expandedRows: {},       // 轮次详情中已展开的题号
  sse: null,
  pollTimer: null,
  liveRunId: null
};

/* ------------------------------------------------------------
 * 小工具
 * ---------------------------------------------------------- */

function $(sel) { return document.querySelector(sel); }
function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }

/** ISO 时间 → 本地「YYYY-MM-DD HH:mm」 */
function fmtDateTime(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** ISO 时间 → 「MM-DD HH:mm」（侧边栏用，短一些） */
function fmtShort(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** 秒 → 「12 秒 / 1 分 05 秒」 */
function fmtSec(sec) {
  if (sec === null || sec === undefined || isNaN(sec)) return '—';
  var s = Math.max(0, Math.round(Number(sec)));
  if (s < 60) return s + ' 秒';
  var m = Math.floor(s / 60);
  var r = s % 60;
  return r ? (m + ' 分 ' + pad2(r) + ' 秒') : (m + ' 分钟');
}

function domainOf(url) {
  if (!url) return '未填写网址';
  try { return new URL(url).host || url; } catch (e) { return String(url); }
}

function parseQuestions(text) {
  return String(text || '').split(/\r?\n/).map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
}

/** 状态徽章 */
function statusBadge(status) {
  var cls = (status === 'running') ? 'running'
    : (status === 'paused') ? 'paused'
    : (status === 'done') ? 'done'
    : (status === 'stopped') ? 'stopped'
    : 'failed';
  var text = STATUS_TEXT[status] || status || '未知';
  return '<span class="badge badge-' + cls + '">' + esc(text) + '</span>';
}

/** 运行中的轮次是否处于「活动」状态（进行中或已暂停） */
function isRunActive(run) {
  return !!run && (run.status === 'running' || run.status === 'paused');
}

/* ------------------------------------------------------------
 * 回答来源
 *   与后端 lib/robot.js 的判定保持一致：
 *     qa    = 问答库      → 蓝色
 *     unit  = 单位知识库  → 绿色
 *     other = 其他        → 红色
 * ---------------------------------------------------------- */

var SOURCE_STYLE = {
  qa: { cls: 'src-qa', text: '问答库' },
  unit: { cls: 'src-unit', text: '单位知识库' },
  other: { cls: 'src-other', text: '其他' }
};

/** 从署名行里取「内容来自：X」 */
function extractSourceLabel(attribution) {
  var t = String(attribution || '').trim();
  if (!t) return '';
  var m = t.match(/内容来自[：:]\s*([^\n，。;；]+)/) || t.match(/来自[：:]\s*([^\n，。;；]+)/);
  return m ? m[1].trim() : '';
}

/** 判定来源；后端已给 source 时直接用 */
function sourceOf(r) {
  if (r && r.source && r.source.category) return r.source;

  var attribution = String((r && r.attribution) || '');
  var recall = String((r && r.recall) || '');
  var titles = (r && r.recallTitles) ? r.recallTitles.join(' ') : '';
  var answer = String((r && r.answer) || '');

  var qaRe = /问答库|常见问题库|FAQ库|faq\s*库|问答知识库/i;
  var unitRe = /单位\s*AI\s*知识库|单位知识库|机构知识库|本校知识库|知识库/i;
  var positive = /召回|命中|匹配/.test(recall || titles);
  var hay = attribution || (titles + ' ' + recall);

  if (positive || attribution) {
    if (qaRe.test(hay)) return { category: 'qa', label: extractSourceLabel(attribution) || '问答库', raw: attribution };
    if (unitRe.test(hay)) return { category: 'unit', label: extractSourceLabel(attribution) || '单位知识库', raw: attribution };
  }
  if (qaRe.test(answer)) return { category: 'qa', label: extractSourceLabel(attribution) || '问答库', raw: attribution };
  if (unitRe.test(answer)) return { category: 'unit', label: extractSourceLabel(attribution) || '单位知识库', raw: attribution };

  return { category: 'other', label: extractSourceLabel(attribution), raw: attribution };
}

/** 来源显示名（没有明确库名时给人话兜底） */
function sourceText(r) {
  var s = sourceOf(r);
  if (s.label && s.label.trim()) return s.label.trim();
  if (s.category === 'other') return (r && r.attribution) ? '大模型回答' : '未标注';
  return SOURCE_STYLE[s.category] ? SOURCE_STYLE[s.category].text : '未标注';
}

/** 来源徽章 */
function sourceBadge(r) {
  var s = sourceOf(r);
  var cls = (SOURCE_STYLE[s.category] || SOURCE_STYLE.other).cls;
  return '<span class="src-badge ' + cls + '" title="' + esc(s.raw || '') + '">' + esc(sourceText(r)) + '</span>';
}

/** 暂停 / 继续 / 停止 按钮组 */
function runControlButtons(paused) {
  if (paused) {
    return '<button type="button" class="btn btn-run btn-sm" data-act="resume-run">▶ 继续</button>' +
           '<button type="button" class="btn btn-danger-ghost btn-sm" data-act="stop-run">■ 停止</button>';
  }
  return '<button type="button" class="btn btn-ghost btn-sm" data-act="pause-run">⏸ 暂停</button>' +
         '<button type="button" class="btn btn-danger-ghost btn-sm" data-act="stop-run">■ 停止</button>';
}

/** 已用时间要扣掉暂停时长，否则暂停期间秒数会一直涨 */
function elapsedMs(run) {
  if (!run || !run.startedAt) return null;
  var end = (run.status !== 'running' && run.finishedAt) ? new Date(run.finishedAt).getTime() : Date.now();
  var ms = end - new Date(run.startedAt).getTime();
  if (run.status === 'paused') {
    ms -= Math.max(0, Date.now() - (run._pausedAt || Date.now()));
  }
  return Math.max(0, ms);
}

/** 单题结果徽章 */
function resultBadge(result) {
  var ok = !!(result && result.completed);
  return '<span class="badge badge-' + (ok ? 'ok' : 'ng') + '">' + (ok ? '成功' : '失败') + '</span>';
}

/** 轻提示 */
function toast(message, kind) {
  var root = $('#toast-root');
  if (!root) return;
  var el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = message;
  root.appendChild(el);
  setTimeout(function () {
    el.style.transition = 'opacity .3s ease';
    el.style.opacity = '0';
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
  }, 3200);
}

/* ------------------------------------------------------------
 * HTTP 封装
 * ---------------------------------------------------------- */

function api(method, path, body) {
  var opts = { method: method, headers: {} };
  if (body !== undefined && body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  return fetch(path, opts).then(function (res) {
    return res.text().then(function (text) {
      var data = null;
      if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
      if (!res.ok) {
        var msg = (data && data.error) ? data.error : ('请求失败（HTTP ' + res.status + '）');
        var err = new Error(msg);
        err.status = res.status;
        throw err;
      }
      return data;
    });
  });
}

/* ------------------------------------------------------------
 * 触发下载
 * ---------------------------------------------------------- */

function triggerDownload(url) {
  var a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, 1500);
}

/* ------------------------------------------------------------
 * 复制到剪贴板
 * ---------------------------------------------------------- */

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(function () { return true; },
      function () { return legacyCopy(text); });
  }
  return Promise.resolve(legacyCopy(text));
}

function legacyCopy(text) {
  try {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------
 * 视图切换
 * ---------------------------------------------------------- */

function showView(name) {
  state.view = name;
  var map = { empty: '#view-empty', project: '#view-project', run: '#view-run' };
  Object.keys(map).forEach(function (key) {
    var el = $(map[key]);
    if (el) el.classList.toggle('hidden', key !== name);
    // 同步到 body，供移动端工具栏等按视图显隐
    document.body.classList.toggle('view-' + key, key === name);
  });
}

/* ------------------------------------------------------------
 * 侧边栏 / 浏览器状态
 * ---------------------------------------------------------- */

function setChrome(chromeStatus) {
  state.chrome = chromeStatus === 'ready' ? 'ready' : 'down';
  var dot = $('#chrome-dot');
  var text = $('#chrome-text');
  if (!dot || !text) return;
  if (state.chrome === 'ready') {
    dot.className = 'dot dot-green';
    text.textContent = '浏览器就绪';
  } else {
    dot.className = 'dot dot-red';
    text.textContent = '浏览器未就绪';
  }
}

function renderSidebar() {
  var list = $('#project-list');
  if (!list) return;

  if (!state.projects.length) {
    list.innerHTML = '<div class="side-empty">暂无项目<br>点击上方「新建项目」开始</div>';
    return;
  }

  list.innerHTML = state.projects.map(function (p) {
    var active = p.id === state.pid ? ' active' : '';
    var runCount = (p.runCount === null || p.runCount === undefined) ? 0 : p.runCount;
    var lastText = p.lastRunAt ? ('最近 ' + fmtShort(p.lastRunAt)) : '尚未测试';
    return '<button type="button" class="project-item' + active + '" data-act="select-project" data-pid="' + esc(p.id) + '">' +
      '<span class="pi-name">' + esc(p.name || '未命名项目') + '</span>' +
      '<span class="pi-domain">' + esc(domainOf(p.url)) + '</span>' +
      '<span class="pi-meta">' +
        '<span class="pi-runs">' + esc(String(runCount)) + ' 轮测试</span>' +
        '<span class="pi-time">' + esc(lastText) + '</span>' +
      '</span>' +
      '</button>';
  }).join('');
}

function refreshChromeStatus() {
  return api('GET', '/api/health').then(function (data) {
    if (data && data.chrome) setChrome(data.chrome);
  }).catch(function () { /* 状态探测失败时静默 */ });
}

/* ------------------------------------------------------------
 * 载入项目列表
 * ---------------------------------------------------------- */

function loadState() {
  return api('GET', '/api/state').then(function (data) {
    state.projects = (data && data.projects) ? data.projects : [];
    setChrome(data ? data.chrome : 'down');

    var exists = state.projects.some(function (p) { return p.id === state.pid; });
    if (!exists) state.pid = null;
    if (!state.pid && state.projects.length) state.pid = state.projects[0].id;

    renderSidebar();

    if (state.pid) return selectProject(state.pid);
    closeLive();
    state.project = null;
    state.runs = [];
    state.run = null;
    state.runId = null;
    showView('empty');
  }).catch(function (err) {
    toast('加载项目列表失败：' + err.message, 'error');
    setChrome('down');
    if (!state.projects.length) showView('empty');
  });
}

/* ------------------------------------------------------------
 * 选中项目
 * ---------------------------------------------------------- */

function selectProject(pid) {
  closeLive();
  state.pid = pid;
  state.run = null;
  state.runId = null;
  state.expandedRows = {};
  renderSidebar();

  return api('GET', '/api/projects/' + encodeURIComponent(pid)).then(function (data) {
    state.project = data ? data.project : null;
    state.runs = (data && data.runs) ? data.runs : [];
    fillConfigForm();
    renderProjectHeader();
    renderRunList();
    renderProgressCard();
    showView('project');
    closeSidebar();

    var active = state.runs.filter(function (r) { return isRunActive(r); })[0];
    if (active) return attachRun(active.id, 'project');
    return null;
  }).catch(function (err) {
    toast('加载项目失败：' + err.message, 'error');
  });
}

function renderProjectHeader() {
  var p = state.project;
  if (!p) return;
  var nameEl = $('#proj-name');
  var urlEl = $('#proj-url');
  if (nameEl) nameEl.textContent = p.name || '未命名项目';
  if (urlEl) urlEl.textContent = p.url || '—';

  var runCount = (p.runCount === null || p.runCount === undefined) ? state.runs.length : p.runCount;
  var meta = ['共 ' + runCount + ' 轮测试'];
  if (p.lastRunAt) meta.push('最近测试：' + fmtDateTime(p.lastRunAt));
  if (p.createdAt) meta.push('创建于 ' + fmtDateTime(p.createdAt));
  var metaEl = $('#proj-meta');
  if (metaEl) metaEl.textContent = meta.join('　·　');

  var countEl = $('#runs-count');
  if (countEl) countEl.textContent = state.runs.length ? ('共 ' + state.runs.length + ' 轮') : '';
}

function defaultQuestions() {
  if (state.bank && state.bank.defaults && state.bank.defaults.length) return state.bank.defaults;
  return DEFAULT_QUESTIONS;
}

function fillConfigForm() {
  var p = state.project;
  if (!p) return;
  var urlInput = $('#cfg-url');
  var qTextarea = $('#cfg-questions');
  if (urlInput) urlInput.value = p.url || '';
  if (qTextarea) {
    var qs = (p.questions && p.questions.length) ? p.questions : defaultQuestions();
    qTextarea.value = qs.join('\n');
  }
  var bankBox = $('#cfg-qbank');
  if (bankBox) {
    bankBox.innerHTML = bankPickerHtml('#cfg-questions');
    syncQbank(bankBox.querySelector('[data-qbank]'));
  }
  renderAigenInto('cfg-aigen', '#cfg-questions');
}

/* ------------------------------------------------------------
 * 轮次列表
 * ---------------------------------------------------------- */

function renderRunList() {
  var box = $('#run-list');
  if (!box) return;

  if (!state.runs.length) {
    box.innerHTML = '<div class="empty-inline">' +
      '<div class="empty-inline-text">还没有测试记录，点下面的按钮跑第一轮吧。</div>' +
      '<button type="button" class="btn btn-run" data-act="focus-run">▶ 开始本轮测试</button>' +
      '</div>';
    return;
  }

  box.innerHTML = state.runs.map(function (r) {
    var ok = (r.okCount === null || r.okCount === undefined) ? 0 : r.okCount;
    var total = (r.total === null || r.total === undefined) ? 0 : r.total;
    var avg = (r.avgSec === null || r.avgSec === undefined) ? '—' : fmtSec(r.avgSec);
    var errorHtml = (r.status === 'failed' && r.error) ? ('<div class="ri-error">' + esc(r.error) + '</div>') : '';
    return '<div class="run-item">' +
      '<div class="ri-left">' +
        '<div class="ri-title">第 ' + esc(String(r.index)) + ' 轮 ' + statusBadge(r.status) + '</div>' +
        '<div class="ri-sub">开始时间：' + esc(fmtDateTime(r.startedAt)) +
          '　·　成功 ' + esc(String(ok)) + '/' + esc(String(total)) +
          '　·　平均耗时 ' + esc(avg) + '</div>' +
        errorHtml +
      '</div>' +
      '<div class="ri-actions">' +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="open-run" data-rid="' + esc(r.id) + '">查看</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="download-run" data-rid="' + esc(r.id) + '">下载报告</button>' +
        '<button type="button" class="btn btn-danger-ghost btn-sm" data-act="delete-run" data-rid="' + esc(r.id) + '">删除</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

/* ------------------------------------------------------------
 * 结果排序 / 统计
 * ---------------------------------------------------------- */

function sortedResults(run) {
  var list = (run && run.results) ? run.results.slice() : [];
  list.sort(function (a, b) { return (a.index || 0) - (b.index || 0); });
  return list;
}

function countOk(run, results) {
  if (run && run.status !== 'running' && run.okCount !== null && run.okCount !== undefined) return run.okCount;
  return results.filter(function (r) { return r.completed; }).length;
}

function avgSecOf(run, results) {
  if (run && run.avgSec !== null && run.avgSec !== undefined) return run.avgSec;
  var arr = results.filter(function (r) { return typeof r.elapsedSec === 'number'; });
  if (!arr.length) return null;
  var sum = arr.reduce(function (acc, r) { return acc + r.elapsedSec; }, 0);
  return Math.round((sum / arr.length) * 10) / 10;
}

/* ------------------------------------------------------------
 * 实时进度卡片（项目详情内，仅跑测试时显示）
 * ---------------------------------------------------------- */

function renderProgressCard() {
  var card = $('#progress-card');
  if (!card) return;

  var run = state.run;
  var visible = !!run && state.view === 'project' && isRunActive(run);
  if (!visible) {
    card.classList.add('hidden');
    card.innerHTML = '';
    return;
  }

  card.classList.remove('hidden');
  var paused = run.status === 'paused';

  var p = run.progress || {};
  var total = p.total || run.total || 0;
  var current = (p.current === null || p.current === undefined) ? 0 : p.current;
  var pct = total ? Math.min(100, Math.round(current / total * 100)) : 0;
  var phaseText = PHASE_TEXT[p.phase] || p.phase || '准备中';

  var results = sortedResults(run);
  var liveHtml = '';
  if (results.length) {
    liveHtml = '<div class="live-list"><div class="live-title">已完成题目</div>' +
      results.map(function (r) {
        var words = r.card ? '卡片' : ((r.answer ? String(r.answer).length : 0) + ' 字');
        return '<div class="live-item">' +
          '<span class="li-idx">第 ' + esc(String(r.index)) + ' 题</span>' +
          resultBadge(r) +
          '<span class="li-q">' + esc(r.question || '') + '</span>' +
          '<span class="muted">' + esc(fmtSec(r.elapsedSec)) + '　' + esc(words) + '</span>' +
        '</div>';
      }).join('') + '</div>';
  }

  card.innerHTML =
    '<div class="card-head">' +
      '<h2 class="card-title">' + (paused ? '⏸ 本轮测试已暂停' : '本轮测试进行中…') + '</h2>' +
      '<div class="run-controls">' +
        '<span class="muted">已用时间 <b data-elapsed>—</b></span>' +
        runControlButtons(paused) +
      '</div>' +
    '</div>' +
    (paused ? '<div class="paused-note">当前题目跑完后已停下。点「▶ 继续」接着跑剩下的题目，或点「■ 停止」结束本轮（已完成的结果会保留）。</div>' : '') +
    '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
    '<div class="progress-line">' +
      '<span class="progress-count">第 ' + esc(String(current)) + ' / ' + esc(String(total)) + ' 题</span>' +
      '<span class="progress-phase">' + esc(phaseText) + '</span>' +
      (p.message ? '<span class="muted">' + esc(p.message) + '</span>' : '') +
    '</div>' +
    '<div class="progress-q">' + esc(p.question || '正在准备第一个问题…') + '</div>' +
    liveHtml;

  tickElapsed();
}

/* ------------------------------------------------------------
 * 轮次详情视图
 * ---------------------------------------------------------- */

function attachRun(rid, view) {
  closeLive();
  return api('GET', '/api/runs/' + encodeURIComponent(rid)).then(function (run) {
    state.runId = rid;
    state.run = run;
    state.expandedRows = {};
    if (view === 'project') {
      showView('project');
      renderProgressCard();
    } else {
      showView('run');
      renderRunView();
    }
    if (isRunActive(run)) subscribeRun(rid);
    return run;
  }).catch(function (err) {
    toast('加载轮次失败：' + err.message, 'error');
  });
}

function openRunView(rid) {
  state.expandedRows = {};
  return attachRun(rid, 'run');
}

function renderRunView() {
  var run = state.run;
  if (!run) return;

  var results = sortedResults(run);
  var total = run.total || results.length || 0;
  var okCount = countOk(run, results);

  var titleEl = $('#run-title');
  if (titleEl) titleEl.textContent = '第 ' + (run.index === null || run.index === undefined ? '?' : run.index) + ' 轮测试';

  var subEl = $('#run-head-sub');
  if (subEl) {
    var parts = [statusBadge(run.status)];
    parts.push('<span>开始：' + esc(fmtDateTime(run.startedAt)) + '</span>');
    if (run.finishedAt) parts.push('<span>结束：' + esc(fmtDateTime(run.finishedAt)) + '</span>');
    if ((run.status === 'failed' || run.status === 'stopped') && run.error) parts.push('<span class="ri-error">' + esc(run.error) + '</span>');
    subEl.innerHTML = parts.join('<span class="muted">·</span>');
  }

  // 运行中 / 已暂停：在轮次详情里也能暂停、继续、停止
  var ctrlBox = $('#run-controls');
  if (ctrlBox) {
    if (isRunActive(run)) {
      ctrlBox.style.display = '';
      ctrlBox.innerHTML = runControlButtons(run.status === 'paused');
    } else {
      ctrlBox.style.display = 'none';
      ctrlBox.innerHTML = '';
    }
  }

  renderRunLiveBanner();
  renderRunStats(run, results, total, okCount);
  renderRunResults(run, results);

  var countEl = $('#res-count');
  if (countEl) countEl.textContent = '共 ' + results.length + ' / ' + total + ' 题';
}

function renderRunLiveBanner() {
  var box = $('#run-live');
  if (!box) return;
  var run = state.run;

  if (!isRunActive(run)) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }

  box.classList.remove('hidden');
  var p = run.progress || {};
  var total = p.total || run.total || 0;
  var current = (p.current === null || p.current === undefined) ? 0 : p.current;
  var pct = total ? Math.min(100, Math.round(current / total * 100)) : 0;
  var phaseText = PHASE_TEXT[p.phase] || p.phase || '准备中';

  box.className = 'card progress-card';
  box.innerHTML =
    '<div class="card-head">' +
      '<h2 class="card-title">本轮测试进行中…</h2>' +
      '<span class="muted">已用时间 <b data-elapsed>—</b></span>' +
    '</div>' +
    '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
    '<div class="progress-line">' +
      '<span class="progress-count">第 ' + esc(String(current)) + ' / ' + esc(String(total)) + ' 题</span>' +
      '<span class="progress-phase">' + esc(phaseText) + '</span>' +
      (p.message ? '<span class="muted">' + esc(p.message) + '</span>' : '') +
    '</div>' +
    '<div class="progress-q">' + esc(p.question || '正在准备第一个问题…') + '</div>';

  tickElapsed();
}

function renderRunStats(run, results, total, okCount) {
  var box = $('#run-stats');
  if (!box) return;

  var done = results.length;
  var rate = total ? Math.round(okCount / total * 100) : 0;
  var avg = avgSecOf(run, results);

  var secs = results.filter(function (r) { return typeof r.elapsedSec === 'number'; })
    .map(function (r) { return { index: r.index, sec: r.elapsedSec }; });
  var fastest = null, slowest = null;
  secs.forEach(function (item) {
    if (fastest === null || item.sec < fastest.sec) fastest = item;
    if (slowest === null || item.sec > slowest.sec) slowest = item;
  });

  function card(label, value, cls, small) {
    return '<div class="stat-card">' +
      '<div class="stat-label">' + esc(label) + '</div>' +
      '<div class="stat-value' + (cls ? ' ' + cls : '') + (small ? ' small' : '') + '">' + esc(value) + '</div>' +
    '</div>';
  }

  var rateCls = !total ? '' : (rate >= 80 ? 'ok' : (rate >= 50 ? '' : 'bad'));

  box.innerHTML =
    card('总题数', String(total), 'primary') +
    card('成功题数', okCount + ' / ' + total, okCount === total && total ? 'ok' : '') +
    card('成功率', rate + '%', rateCls) +
    card('平均耗时', avg === null ? '—' : fmtSec(avg)) +
    card('最快', fastest ? (fmtSec(fastest.sec) + '（第 ' + fastest.index + ' 题）') : '—', '', true) +
    card('最慢', slowest ? (fmtSec(slowest.sec) + '（第 ' + slowest.index + ' 题）') : '—', '', true);

  if (!done) {
    box.innerHTML += '<div class="stat-card"><div class="stat-label">提示</div>' +
      '<div class="stat-value small">' + (isRunActive(run) ? '测试进行中，结果将实时出现' : '暂无结果数据') + '</div></div>';
  }
}

function renderRunResults(run, results) {
  var box = $('#run-results');
  if (!box) return;

  if (!results.length) {
    box.innerHTML = '<div class="empty-inline">' +
      (isRunActive(run) ? '正在等待第一题的结果…' : '本轮暂无测试结果。') + '</div>';
    return;
  }

  var rows = results.map(function (r) {
    var idx = r.index;
    var open = !!state.expandedRows[idx];
    var words = r.card ? '<span class="badge badge-card">卡片</span>' : esc(String(r.answer ? String(r.answer).length : 0));

    var shotHtml;
    if (r.hasScreenshot === false) {
      shotHtml = '<div class="shot-fallback">本题暂无截图</div>';
    } else {
      shotHtml = '<img class="shot" loading="lazy" alt="第 ' + esc(String(idx)) + ' 题页面截图" ' +
        'src="/api/runs/' + encodeURIComponent(run.id) + '/shot/' + encodeURIComponent(String(idx)) + '">' +
        '<div class="shot-fallback hidden">截图暂不可用</div>';
    }

    return '<tr class="res-row' + (open ? ' open' : '') + '" data-act="toggle-row" data-index="' + esc(String(idx)) + '">' +
        '<td class="res-idx">' + esc(String(idx)) + '<span class="res-toggle">' + (open ? '▲' : '▼') + '</span></td>' +
        '<td><div class="res-q">' + esc(r.question || '') + '</div></td>' +
        '<td>' + esc(fmtSec(r.elapsedSec)) + '</td>' +
        '<td>' + words + '</td>' +
        '<td class="col-src">' + sourceBadge(r) + '</td>' +
        '<td>' + resultBadge(r) + '</td>' +
      '</tr>' +
      '<tr class="res-detail' + (open ? ' open' : '') + '" data-detail-index="' + esc(String(idx)) + '">' +
        '<td colspan="6"><div class="detail-wrap"><div class="detail-body">' +
          '<div class="detail-block"><div class="detail-label">完整问题</div>' +
            '<div class="pre">' + esc(r.question || '') + '</div></div>' +
          '<div class="detail-block"><div class="detail-label">回答来源</div>' +
            '<div class="detail-source">' + sourceBadge(r) +
              (sourceOf(r).raw ? '<span class="src-raw">页面署名：' + esc(sourceOf(r).raw) + '</span>' : '') +
            '</div></div>' +
          '<div class="detail-block"><div class="detail-label">完整回答原文</div>' +
            (r.card ? '<div class="card-hint">本题为卡片型回答，请见页面截图</div>' : '') +
            '<div class="pre answer">' + esc(r.answer || '（无回答文本）') + '</div></div>' +
          (r.note ? '<div class="detail-note">备注：' + esc(r.note) + '</div>' : '') +
          (r.flow ? '<details class="flow"><summary>查看检索过程文本</summary><div class="pre">' + esc(r.flow) + '</div></details>' : '') +
          (r.sendTime || r.answerTime
            ? '<div class="detail-note muted">发送时间：' + esc(r.sendTime || '—') + '　·　回答时间：' + esc(r.answerTime || '—') + '</div>'
            : '') +
          '<div class="detail-block"><div class="detail-label">页面截图</div>' +
            '<div class="shot-box">' + shotHtml + '</div></div>' +
        '</div></div></td>' +
      '</tr>';
  }).join('');

  box.innerHTML = '<table class="res-table">' +
    '<thead><tr>' +
      '<th class="col-idx">题号</th>' +
      '<th>问题</th>' +
      '<th class="col-sec">耗时</th>' +
      '<th class="col-words">回答字数</th>' +
      '<th class="col-src">来源</th>' +
      '<th class="col-status">结果</th>' +
    '</tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
  '</table>';

  // 已展开的行按内容高度展开
  $all('#run-results .res-detail.open .detail-wrap').forEach(function (wrap) {
    wrap.style.maxHeight = wrap.scrollHeight + 'px';
  });

  // 截图加载失败 → 显示占位；加载成功 → 修正展开高度
  $all('#run-results .shot').forEach(function (img) {
    img.addEventListener('error', function () {
      img.classList.add('hidden');
      var fallback = img.parentNode ? img.parentNode.querySelector('.shot-fallback') : null;
      if (fallback) fallback.classList.remove('hidden');
      recalcDetailHeight(img);
    });
    img.addEventListener('load', function () { recalcDetailHeight(img); });
  });
}

function recalcDetailHeight(node) {
  var detail = node.closest ? node.closest('.res-detail') : null;
  if (!detail || !detail.classList.contains('open')) return;
  var wrap = detail.querySelector('.detail-wrap');
  if (wrap) wrap.style.maxHeight = wrap.scrollHeight + 'px';
}

/* ------------------------------------------------------------
 * 表格行展开 / 收起（平滑过渡，不重绘整表）
 * ---------------------------------------------------------- */

function toggleRow(index) {
  var detail = document.querySelector('.res-detail[data-detail-index="' + index + '"]');
  var row = document.querySelector('.res-row[data-index="' + index + '"]');
  if (!detail || !row) return;

  var willOpen = !detail.classList.contains('open');
  detail.classList.toggle('open', willOpen);
  row.classList.toggle('open', willOpen);

  var wrap = detail.querySelector('.detail-wrap');
  if (wrap) wrap.style.maxHeight = willOpen ? (wrap.scrollHeight + 'px') : '0px';

  var toggle = row.querySelector('.res-toggle');
  if (toggle) toggle.textContent = willOpen ? '▲' : '▼';

  if (willOpen) state.expandedRows[index] = true;
  else delete state.expandedRows[index];
}

/* ------------------------------------------------------------
 * 计时
 * ---------------------------------------------------------- */

function tickElapsed() {
  var run = state.run;
  if (!run) return;
  var ms = elapsedMs(run);
  var sec = (ms === null || isNaN(ms)) ? null : Math.round(ms / 1000);
  $all('[data-elapsed]').forEach(function (el) {
    el.textContent = sec === null ? '—' : fmtSec(sec);
  });
}

/* ------------------------------------------------------------
 * SSE 订阅 + 轮询降级
 * ---------------------------------------------------------- */

function subscribeRun(rid) {
  closeLive();
  state.liveRunId = rid;

  var es;
  try {
    es = new EventSource('/api/runs/' + encodeURIComponent(rid) + '/events');
  } catch (e) {
    startPolling(rid);
    return;
  }
  state.sse = es;

  es.onmessage = function (ev) {
    if (state.sse !== es) return;
    var msg = null;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (!msg) return;
    handleSSE(rid, msg);
  };

  es.onerror = function () {
    if (state.sse !== es) return;   // 已被主动关闭
    state.sse = null;
    try { es.close(); } catch (e) { /* ignore */ }
    startPolling(rid);              // 降级为每 3 秒轮询
  };
}

function closeLive() {
  if (state.sse) {
    var es = state.sse;
    state.sse = null;
    es.onmessage = null;
    es.onerror = null;
    try { es.close(); } catch (e) { /* ignore */ }
  }
  stopPolling();
  state.liveRunId = null;
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function startPolling(rid) {
  stopPolling();
  state.pollTimer = setInterval(function () {
    if (state.runId !== rid) { stopPolling(); return; }
    api('GET', '/api/runs/' + encodeURIComponent(rid)).then(function (run) {
      if (state.runId !== rid) { stopPolling(); return; }
      var wasActive = isRunActive(state.run);
      var prev = state.run ? state.run.status : null;
      state.run = run;
      if (run.status === 'paused' && prev !== 'paused') state.run._pausedAt = Date.now();
      rerenderLive();
      if (!isRunActive(run) && wasActive) onRunFinished();
      else if (!isRunActive(run)) stopPolling();
    }).catch(function () { /* 单次失败忽略，下轮重试 */ });
  }, 3000);
}

function handleSSE(rid, msg) {
  if (state.runId !== rid || !state.run) return;

  if (msg.type === 'status') {
    var status = msg.status || state.run.status;
    var prev = state.run.status;
    state.run.status = status;
    if (msg.okCount !== undefined && msg.okCount !== null) state.run.okCount = msg.okCount;
    if (msg.avgSec !== undefined && msg.avgSec !== null) state.run.avgSec = msg.avgSec;
    if (msg.error) state.run.error = msg.error;
    if (msg.finishedAt) state.run.finishedAt = msg.finishedAt;
    // 记录暂停起点，用于扣掉暂停时长
    if (status === 'paused' && prev !== 'paused') state.run._pausedAt = Date.now();
    if (status === 'running') state.run._pausedAt = null;
    if (status === 'done' || status === 'failed' || status === 'stopped') {
      onRunFinished();
      return;
    }
    rerenderLive(true);
    return;
  }

  if (msg.type === 'progress') {
    if (msg.progress) {
      state.run.progress = msg.progress;
      if (msg.progress.total) state.run.total = msg.progress.total;
    }
    rerenderLive(false);   // 进度变化只需刷新进度区
    return;
  }

  if (msg.type === 'result' && msg.result) {
    upsertResult(msg.result);
    rerenderLive(true);
  }
}

function upsertResult(result) {
  var run = state.run;
  if (!run) return;
  if (!run.results) run.results = [];
  var replaced = false;
  for (var i = 0; i < run.results.length; i++) {
    if (run.results[i].index === result.index) {
      run.results[i] = result;
      replaced = true;
      break;
    }
  }
  if (!replaced) run.results.push(result);
}

/** full=false 时只刷新进度条区域；full=true 时刷新统计与结果表 */
function rerenderLive(full) {
  if (!state.run) return;
  if (state.view === 'run') {
    if (full) renderRunView();
    else { renderRunLiveBanner(); tickElapsed(); }
  } else if (state.view === 'project') {
    renderProgressCard();
  }
}

/* ------------------------------------------------------------
 * 轮次结束
 * ---------------------------------------------------------- */

function onRunFinished() {
  var rid = state.runId;
  closeLive();

  var runPromise = rid
    ? api('GET', '/api/runs/' + encodeURIComponent(rid)).catch(function () { return null; })
    : Promise.resolve(null);

  runPromise.then(function (run) {
    if (run && state.runId === rid) state.run = run;
    if (state.view === 'run') renderRunView();
    else renderProgressCard();

    var finishedRun = state.run;
    if (finishedRun && finishedRun.status === 'failed') {
      toast('本轮测试失败：' + (finishedRun.error || '未知错误'), 'error');
    } else if (finishedRun && finishedRun.status === 'stopped') {
      toast('第 ' + finishedRun.index + ' 轮测试已停止，已完成的 ' + (finishedRun.okCount || 0) + ' 题结果已保留', 'success');
    } else if (finishedRun) {
      toast('第 ' + finishedRun.index + ' 轮测试已完成', 'success');
    }
  });

  if (!state.pid) return;
  api('GET', '/api/projects/' + encodeURIComponent(state.pid)).then(function (data) {
    state.project = data ? data.project : state.project;
    state.runs = (data && data.runs) ? data.runs : state.runs;
    renderProjectHeader();
    renderRunList();
    renderSidebar();
  }).catch(function () { /* ignore */ });
}

/* ------------------------------------------------------------
 * 分类测试问题库
 *   问题库由后端 /api/question-bank 提供；项目最终仍然只保存一个扁平的问题数组，
 *   下方的 textarea 是唯一数据源，勾选面板只是便捷的填充方式。
 * ---------------------------------------------------------- */

function catQuestions(cat) {
  var out = [];
  (cat.groups || []).forEach(function (g) {
    (g.questions || []).forEach(function (q) { out.push(q); });
  });
  return out;
}

function bankPickerHtml(targetSel) {
  if (!state.bank || !state.bank.categories) {
    return '<div class="qbank qbank-loading">问题库加载中…</div>';
  }
  var cats = state.bank.categories.map(function (cat) {
    var groups = (cat.groups || []).map(function (g) {
      var head = g.name ? '<div class="qbank-group-name">' + esc(g.name) + '</div>' : '';
      var qs = (g.questions || []).map(function (q) {
        return '<label class="qbank-q">' +
          '<input type="checkbox" data-q="' + esc(q) + '">' +
          '<span class="qbank-q-text">' + esc(q) + '</span></label>';
      }).join('');
      return '<div class="qbank-group">' + head + qs + '</div>';
    }).join('');
    return '<div class="qbank-cat" data-cat="' + cat.id + '">' +
      '<div class="qbank-cat-head" data-act="toggle-cat">' +
        '<span class="qbank-caret">▸</span>' +
        '<span class="qbank-icon">' + (cat.icon || '📁') + '</span>' +
        '<span class="qbank-name">' + esc(cat.name) + '</span>' +
        '<span class="qbank-cat-desc">' + esc(cat.desc || '') + '</span>' +
        '<span class="qbank-cat-count" data-cat-count="' + cat.id + '">0/' + cat.total + '</span>' +
        '<span class="qbank-cat-tools">' +
          '<button type="button" class="qbank-mini" data-act="cat-all" data-cat="' + cat.id + '">全选</button>' +
          '<button type="button" class="qbank-mini" data-act="cat-none" data-cat="' + cat.id + '">清空</button>' +
        '</span>' +
      '</div>' +
      '<div class="qbank-cat-body">' + groups + '</div>' +
    '</div>';
  }).join('');

  return '<div class="qbank" data-qbank data-target="' + targetSel + '">' +
    '<div class="qbank-toolbar">' +
      '<span class="qbank-sel">已选 <b data-qbank-count>0</b> 题' +
        '<span class="qbank-total">（问题库共 ' + state.bank.total + ' 题）</span></span>' +
      '<span class="qbank-tools">' +
        '<button type="button" class="qbank-mini" data-act="bank-all">全选全部</button>' +
        '<button type="button" class="qbank-mini" data-act="bank-none">清空全部</button>' +
      '</span>' +
    '</div>' +
    '<div class="qbank-cats">' + cats + '</div>' +
  '</div>';
}

/* 根据 textarea 内容刷新勾选状态与各类计数 */
function syncQbank(root) {
  root = root || $('[data-qbank]');
  if (!root || !state.bank) return;
  var ta = $(root.getAttribute('data-target'));
  var list = parseQuestions(ta ? ta.value : '');
  var set = {};
  list.forEach(function (q) { set[q] = true; });

  $all('input[data-q]', root).forEach(function (cb) {
    cb.checked = !!set[cb.getAttribute('data-q')];
  });
  var countEl = root.querySelector('[data-qbank-count]');
  if (countEl) countEl.textContent = list.length;

  state.bank.categories.forEach(function (cat) {
    var n = catQuestions(cat).filter(function (q) { return set[q]; }).length;
    var el = root.querySelector('[data-cat-count="' + cat.id + '"]');
    if (el) {
      el.textContent = n + '/' + cat.total;
      if (n > 0) el.classList.add('has'); else el.classList.remove('has');
    }
  });
}

function syncQbankByTarget(sel) {
  var root = $('[data-qbank][data-target="' + sel + '"]');
  if (root) syncQbank(root);
}

/* 往 textarea 追加 / 移除问题 */
function bankAppend(targetSel, questions) {
  var ta = $(targetSel);
  if (!ta) return;
  var list = parseQuestions(ta.value);
  questions.forEach(function (q) { if (list.indexOf(q) === -1) list.push(q); });
  ta.value = list.join('\n');
  syncQbankByTarget(targetSel);
}

function bankRemove(targetSel, questions) {
  var ta = $(targetSel);
  if (!ta) return;
  var drop = {};
  questions.forEach(function (q) { drop[q] = true; });
  var list = parseQuestions(ta.value).filter(function (q) { return !drop[q]; });
  ta.value = list.join('\n');
  syncQbankByTarget(targetSel);
}

function bankSetAll(targetSel, on) {
  if (!state.bank) return;
  if (!on) {
    var ta = $(targetSel);
    if (ta) ta.value = '';
    syncQbankByTarget(targetSel);
    return;
  }
  var all = [];
  state.bank.categories.forEach(function (c) { all = all.concat(catQuestions(c)); });
  bankAppend(targetSel, all);
}

function handleQbankAction(act, el) {
  var root = el.closest ? el.closest('[data-qbank]') : null;
  if (!root) return false;
  var targetSel = root.getAttribute('data-target');
  var catId = el.getAttribute('data-cat');
  var cat = null;
  if (catId && state.bank) {
    cat = state.bank.categories.filter(function (c) { return c.id === catId; })[0];
  }

  if (act === 'toggle-cat') {
    var box = el.closest('.qbank-cat');
    if (box) box.classList.toggle('open');
    return true;
  }
  if (act === 'cat-all' && cat) { bankAppend(targetSel, catQuestions(cat)); return true; }
  if (act === 'cat-none' && cat) { bankRemove(targetSel, catQuestions(cat)); return true; }
  if (act === 'bank-all') { bankSetAll(targetSel, true); return true; }
  if (act === 'bank-none') { bankSetAll(targetSel, false); return true; }
  return false;
}

/* ------------------------------------------------------------
 * AI 生成测试问题（DeepSeek）
 * ---------------------------------------------------------- */

var aigenCache = {};   // targetSel -> 最近一次生成的问题数组

function aigenHtml(targetSel) {
  var info = state.ai || {};
  var configured = !!info.configured;

  var setup = configured ? '' :
    '<div class="aigen-setup">' +
      '<div class="aigen-setup-tip">尚未配置 DeepSeek API Key，请先到「系统设置」中填写并测试连通性。</div>' +
      '<button type="button" class="btn btn-primary btn-sm" data-act="open-settings">前往系统设置</button>' +
    '</div>';

  var counts = [3, 5, 8, 10].map(function (n) {
    return '<option value="' + n + '"' + (n === 5 ? ' selected' : '') + '>' + n + ' 题</option>';
  }).join('');

  return '<div class="aigen" data-aigen data-target="' + targetSel + '">' +
    '<div class="aigen-head">' +
      '<span class="aigen-title">✨ AI 生成问题</span>' +
      '<span class="aigen-hint">给一个关键词或一句话，自动生成测试题</span>' +
      (configured && info.model ? '<span class="aigen-model">' + esc(info.model) + '</span>' : '') +
    '</div>' +
    setup +
    '<div class="aigen-row">' +
      '<input class="input aigen-input" type="text" spellcheck="false" ' +
        'placeholder="例如：座位预约 / 超期罚款 / 电子资源校外访问">' +
      '<select class="input aigen-count">' + counts + '</select>' +
      '<button type="button" class="btn btn-primary btn-sm" data-act="ai-generate">生成</button>' +
    '</div>' +
    '<div class="aigen-result hidden" data-aigen-result></div>' +
  '</div>';
}

function renderAigenInto(containerId, targetSel) {
  var box = $('#' + containerId);
  if (!box) return;
  box.innerHTML = aigenHtml(targetSel);
}

function setAigenBusy(root, busy, text) {
  var btn = root.querySelector('[data-act="ai-generate"]');
  if (btn) { btn.disabled = !!busy; btn.textContent = busy ? (text || '生成中…') : '生成'; }
}

function renderAigenResult(root, questions) {
  var box = root.querySelector('[data-aigen-result]');
  if (!box) return;
  var targetSel = root.getAttribute('data-target');
  aigenCache[targetSel] = questions.slice();

  box.innerHTML =
    '<div class="aigen-result-head">已生成 ' + questions.length + ' 个问题，勾选后加入测试</div>' +
    '<div class="aigen-list">' +
      questions.map(function (q, i) {
        return '<label class="aigen-item"><input type="checkbox" data-aiq="' + i + '" checked>' +
          '<span class="aigen-item-text">' + esc(q) + '</span></label>';
      }).join('') +
    '</div>' +
    '<div class="aigen-result-foot">' +
      '<button type="button" class="btn btn-primary btn-sm" data-act="ai-add-selected">加入选中的问题</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-act="ai-regenerate">重新生成</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-act="ai-close-result">收起</button>' +
    '</div>';
  box.classList.remove('hidden');
}

function aigenError(root, message) {
  var box = root.querySelector('[data-aigen-result]');
  if (!box) return;
  box.innerHTML = '<div class="aigen-error">' + esc(message) + '</div>';
  box.classList.remove('hidden');
}

function aiGenerate(root) {
  var targetSel = root.getAttribute('data-target');
  var input = root.querySelector('.aigen-input');
  var countEl = root.querySelector('.aigen-count');
  var kw = input ? input.value.trim() : '';
  if (!kw) { toast('请先输入一个关键词或问题', 'error'); if (input) input.focus(); return; }

  var ta = $(targetSel);
  var existing = ta ? parseQuestions(ta.value) : [];

  setAigenBusy(root, true);
  api('POST', '/api/ai/generate-questions', {
    keyword: kw,
    count: Number(countEl ? countEl.value : 5) || 5,
    existing: existing
  }).then(function (data) {
    renderAigenResult(root, data.questions || []);
  }).catch(function (err) {
    aigenError(root, err.message);
  }).then(function () {
    setAigenBusy(root, false);
  });
}

function aiAddSelected(root) {
  var targetSel = root.getAttribute('data-target');
  var list = aigenCache[targetSel] || [];
  var picked = [];
  $all('input[data-aiq]', root).forEach(function (cb) {
    if (cb.checked) picked.push(list[Number(cb.getAttribute('data-aiq'))]);
  });
  if (!picked.length) { toast('请先勾选要加入的问题', 'error'); return; }

  var ta = $(targetSel);
  var before = ta ? parseQuestions(ta.value).length : 0;
  bankAppend(targetSel, picked);
  var after = ta ? parseQuestions(ta.value).length : 0;
  var added = after - before;
  var skipped = picked.length - added;

  // 已加入的取消勾选，避免重复加入
  $all('input[data-aiq]', root).forEach(function (cb) { if (cb.checked) cb.checked = false; });

  if (added === 0) toast('选中的问题都已存在，未重复加入', 'error');
  else toast('已加入 ' + added + ' 个问题' + (skipped > 0 ? '（' + skipped + ' 个已存在，自动跳过）' : ''), 'success');
}

function refreshAigenBlocks() {
  $all('[data-aigen]').forEach(function (root) {
    var targetSel = root.getAttribute('data-target');
    var holder = root.parentNode;
    if (!holder) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = aigenHtml(targetSel);
    holder.replaceChild(tmp.firstChild, root);
  });
}

/* ------------------------------------------------------------
 * 系统设置
 * ---------------------------------------------------------- */

function settingsStatusHtml(info) {
  if (!info || !info.configured) {
    return '<span class="ss-dot off"></span>未配置，AI 生成功能不可用';
  }
  var srcText = info.source === 'env' ? '来自环境变量' : '来自本机配置';
  return '<span class="ss-dot on"></span>已配置：<code>' + esc(info.keyMasked) + '</code>' +
    '　<span class="ss-muted">' + srcText + '　模型 ' + esc(info.model) + '</span>';
}

function renderSettingsStatus(info, extra) {
  var box = $('#s-status');
  if (!box) return;
  box.innerHTML = '<div class="settings-line">' + settingsStatusHtml(info) + '</div>' +
    (extra ? '<div class="settings-extra ' + (extra.kind || '') + '">' + esc(extra.text) + '</div>' : '');
}

/* 保存后同步弹窗内的细节（占位提示、"清除密钥"按钮） */
function syncSettingsChrome(info) {
  var keyEl = $('#s-key');
  if (keyEl) keyEl.placeholder = info.configured ? '已配置，如需更换请粘贴新密钥' : 'sk-...';

  var clearBtn = $('[data-act="clear-ai-key"]');
  var actions = $('#modal-root .settings-actions');
  if (!actions) return;
  var shouldShow = info.configured && info.source !== 'env';
  if (shouldShow && !clearBtn) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-danger-ghost btn-sm';
    btn.setAttribute('data-act', 'clear-ai-key');
    btn.textContent = '清除密钥';
    var link = actions.querySelector('.aigen-link');
    actions.insertBefore(btn, link || null);
  } else if (!shouldShow && clearBtn) {
    clearBtn.parentNode.removeChild(clearBtn);
  }
}

function openSettingsModal() {
  var info = state.ai || {};
  var configured = !!info.configured;
  var envLocked = info.source === 'env';

  var root = $('#modal-root');
  root.innerHTML =
    '<div class="modal-backdrop" data-act="modal-backdrop">' +
      '<div class="modal" data-modal-panel>' +
        '<h2 class="modal-title">⚙　系统设置</h2>' +

        '<div class="settings-sec">' +
          '<div class="settings-sec-title">AI 生成问题（DeepSeek）</div>' +
          '<div class="settings-sec-desc">用于「测试问题 → AI 生成问题」功能。密钥仅保存在本机 ' +
            '<code>data/settings.json</code>，不会外传。</div>' +

          '<label class="field"><span class="field-label">API Key' +
            (configured ? ' <span class="hint">留空表示不修改</span>' : '') + '</span>' +
            '<input class="input" id="s-key" type="password" spellcheck="false" ' +
              'placeholder="' + (configured ? '已配置，如需更换请粘贴新密钥' : 'sk-...') + '"></label>' +

          '<label class="field"><span class="field-label">接口地址 <span class="hint">可选</span></span>' +
            '<input class="input" id="s-base" type="text" spellcheck="false" ' +
              'placeholder="https://api.deepseek.com" value="' + esc(info.baseUrl || '') + '"></label>' +

          '<label class="field"><span class="field-label">模型 <span class="hint">可选</span></span>' +
            '<input class="input" id="s-model" type="text" spellcheck="false" ' +
              'placeholder="deepseek-chat" value="' + esc(info.model || '') + '"></label>' +

          '<div class="settings-status" id="s-status"></div>' +

          '<div class="settings-actions">' +
            '<button type="button" class="btn btn-ghost btn-sm" data-act="test-settings">测试连通性</button>' +
            (configured && !envLocked ? '<button type="button" class="btn btn-danger-ghost btn-sm" data-act="clear-ai-key">清除密钥</button>' : '') +
            '<a class="aigen-link" href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener">获取密钥 ↗</a>' +
          '</div>' +

          (envLocked ? '<div class="settings-note">检测到环境变量 <code>DEEPSEEK_API_KEY</code>，其优先级高于此处配置，' +
            '保存后不会生效。</div>' : '') +
        '</div>' +

        '<div class="modal-error hidden" id="s-error"></div>' +
        '<div class="modal-foot">' +
          '<button type="button" class="btn btn-ghost" data-act="close-modal">取消</button>' +
          '<button type="button" class="btn btn-primary" data-act="save-settings">保存</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  renderSettingsStatus(info);
  var keyInput = $('#s-key');
  if (keyInput && !configured) keyInput.focus();
}

function settingsError(msg) {
  var box = $('#s-error');
  if (!box) return;
  if (!msg) { box.classList.add('hidden'); box.textContent = ''; return; }
  box.textContent = msg;
  box.classList.remove('hidden');
}

/* 收集表单 → 保存；返回 Promise<status> */
function saveSettingsFromForm() {
  var keyEl = $('#s-key');
  var baseEl = $('#s-base');
  var modelEl = $('#s-model');
  var payload = {};
  if (keyEl && keyEl.value.trim()) payload.apiKey = keyEl.value.trim();
  if (baseEl) payload.baseUrl = baseEl.value.trim() || 'https://api.deepseek.com';
  if (modelEl) payload.model = modelEl.value.trim() || 'deepseek-chat';

  return api('POST', '/api/ai/config', payload).then(function (info) {
    state.ai = info;
    if (keyEl) keyEl.value = '';
    refreshAigenBlocks();
    return info;
  });
}

function saveSettings() {
  settingsError('');
  saveSettingsFromForm().then(function (info) {
    syncSettingsChrome(info);
    renderSettingsStatus(info, { kind: 'ok', text: '设置已保存' });
    toast('设置已保存', 'success');
  }).catch(function (err) {
    settingsError('保存失败：' + err.message);
  });
}

/* 先保存再测，避免"改了没保存"测的是旧配置 */
function testSettings() {
  settingsError('');
  var btn = $('[data-act="test-settings"]');
  if (btn) { btn.disabled = true; btn.textContent = '测试中…'; }
  renderSettingsStatus(state.ai, { kind: '', text: '正在测试连通性…' });

  saveSettingsFromForm().then(function () {
    return api('POST', '/api/ai/test');
  }).then(function (r) {
    syncSettingsChrome(state.ai);
    if (r && r.ok) {
      renderSettingsStatus(state.ai, { kind: 'ok', text: '连通性正常，模型 ' + (r.model || '') + ' 已响应：' + (r.reply || '') });
      toast('连通性测试通过', 'success');
    } else {
      renderSettingsStatus(state.ai, { kind: 'bad', text: '连通性测试失败：' + ((r && r.error) || '未知错误') });
    }
  }).catch(function (err) {
    renderSettingsStatus(state.ai, { kind: 'bad', text: '连通性测试失败：' + err.message });
  }).then(function () {
    if (btn) { btn.disabled = false; btn.textContent = '测试连通性'; }
  });
}

function clearAiKey() {
  if (!confirm('确定清除已保存的 DeepSeek API Key 吗？')) return;
  api('POST', '/api/ai/config', { apiKey: '' }).then(function (info) {
    state.ai = info;
    refreshAigenBlocks();
    var baseEl = $('#s-base');
    var modelEl = $('#s-model');
    openSettingsModal();
    if (baseEl) baseEl.value = info.baseUrl || '';
    if (modelEl) modelEl.value = info.model || '';
    renderSettingsStatus(info, { kind: '', text: '密钥已清除' });
    toast('密钥已清除');
  }).catch(function (err) {
    settingsError('清除失败：' + err.message);
  });
}

function handleAigenAction(act, el) {
  var root = el.closest ? el.closest('[data-aigen]') : null;
  if (!root) return false;
  if (act === 'ai-generate') { aiGenerate(root); return true; }
  if (act === 'ai-regenerate') { aiGenerate(root); return true; }
  if (act === 'ai-add-selected') { aiAddSelected(root); return true; }
  if (act === 'ai-close-result') {
    var box = root.querySelector('[data-aigen-result]');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
    return true;
  }
  return false;
}

/* ------------------------------------------------------------
 * 新建 / 编辑项目模态框
 * ---------------------------------------------------------- */

function openProjectModal(mode) {
  var isEdit = (mode === 'edit');
  var p = isEdit ? state.project : null;
  var name = p ? (p.name || '') : '';
  var url = p ? (p.url || '') : '';
  var qs = (p && p.questions && p.questions.length) ? p.questions : defaultQuestions();

  var root = $('#modal-root');
  root.innerHTML =
    '<div class="modal-backdrop" data-act="modal-backdrop">' +
      '<div class="modal modal-lg" data-modal-panel>' +
        '<h2 class="modal-title">' + (isEdit ? '编辑项目' : '新建项目') + '</h2>' +
        '<label class="field"><span class="field-label">项目名称</span>' +
          '<input class="input" id="m-name" type="text" placeholder="例如：xxx大学图书馆 AI 馆员" value="' + esc(name) + '"></label>' +
        '<label class="field"><span class="field-label">机器人网址</span>' +
          '<input class="input" id="m-url" type="text" spellcheck="false" placeholder="https://robot.example.com/chat" value="' + esc(url) + '"></label>' +
        '<div class="field"><span class="field-label">测试问题 ' +
          '<span class="hint">按业务模块勾选、或用 AI 生成，也可在最下方直接编辑（一行一个问题）</span></span>' +
          bankPickerHtml('#m-questions') +
          '<textarea class="textarea qbank-target" id="m-questions" rows="8" spellcheck="false">' + esc(qs.join('\n')) + '</textarea>' +
          '<div id="m-aigen"></div>' +
        '</div>' +
        '<div class="modal-error hidden" id="m-error"></div>' +
        '<div class="modal-foot">' +
          '<button type="button" class="btn btn-ghost" data-act="close-modal">取消</button>' +
          '<button type="button" class="btn btn-primary" data-act="submit-modal" data-mode="' + (isEdit ? 'edit' : 'create') + '">' +
            (isEdit ? '保存' : '创建项目') + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  syncQbank($('#modal-root [data-qbank]'));
  renderAigenInto('m-aigen', '#m-questions');

  var nameInput = $('#m-name');
  if (nameInput) {
    nameInput.focus();
    if (name) nameInput.select();
  }
}

function closeModal() {
  var root = $('#modal-root');
  if (root) root.innerHTML = '';
}

function modalError(message) {
  var box = $('#m-error');
  if (!box) return;
  box.textContent = message;
  box.classList.remove('hidden');
}

function submitProjectModal(mode) {
  var name = ($('#m-name') ? $('#m-name').value : '').trim();
  var url = ($('#m-url') ? $('#m-url').value : '').trim();
  var questions = parseQuestions($('#m-questions') ? $('#m-questions').value : '');

  if (!name) { modalError('请填写项目名称'); return; }
  if (!url) { modalError('请填写机器人网址'); return; }
  if (!/^https?:\/\//i.test(url)) { modalError('网址需要以 http:// 或 https:// 开头'); return; }
  if (!questions.length) { modalError('请至少填写一个测试问题（一行一个问题）'); return; }

  var payload = { name: name, url: url, questions: questions };
  var promise = (mode === 'edit')
    ? api('PATCH', '/api/projects/' + encodeURIComponent(state.pid), payload)
    : api('POST', '/api/projects', payload);

  promise.then(function (project) {
    closeModal();
    if (mode === 'edit') {
      toast('项目已保存', 'success');
      state.project = project || state.project;
      fillConfigForm();
      renderProjectHeader();
      return loadState();
    }
    toast('项目已创建', 'success');
    state.pid = project && project.id ? project.id : null;
    return loadState();
  }).catch(function (err) {
    modalError(err.message);
  });
}

/* ------------------------------------------------------------
 * 保存配置 / 开始测试
 * ---------------------------------------------------------- */

function saveConfig() {
  if (!state.pid) return;
  var url = ($('#cfg-url') ? $('#cfg-url').value : '').trim();
  var questions = parseQuestions($('#cfg-questions') ? $('#cfg-questions').value : '');
  if (!url) { toast('请填写机器人网址', 'error'); return; }
  if (!questions.length) { toast('请至少填写一个测试问题', 'error'); return; }

  api('PATCH', '/api/projects/' + encodeURIComponent(state.pid), { url: url, questions: questions })
    .then(function (project) {
      state.project = project || state.project;
      renderProjectHeader();
      renderSidebar();
      toast('配置已保存（共 ' + questions.length + ' 个问题）', 'success');
    })
    .catch(function (err) { toast('保存失败：' + err.message, 'error'); });
}

function startRun() {
  if (!state.pid) return;

  var url = ($('#cfg-url') ? $('#cfg-url').value : '').trim();
  var questions = parseQuestions($('#cfg-questions') ? $('#cfg-questions').value : '');
  if (!url) { toast('请先填写机器人网址', 'error'); return; }
  if (!questions.length) { toast('请先填写至少一个测试问题', 'error'); return; }

  // 页面上有两个「开始本轮测试」（项目头部 + 右侧配置卡片），一起置为忙碌态
  var btns = document.querySelectorAll('[data-act="start-run"]');
  var busy = function (on) {
    for (var i = 0; i < btns.length; i++) {
      btns[i].disabled = !!on;
      btns[i].textContent = on ? '正在启动…' : '▶ 开始本轮测试';
    }
  };
  busy(true);

  api('POST', '/api/projects/' + encodeURIComponent(state.pid) + '/runs', { questions: questions })
    .then(function (res) {
      var runId = res ? res.runId : null;
      if (!runId) throw new Error('服务端未返回 runId');
      toast('第 ' + (res.index === undefined ? '' : res.index) + ' 轮测试已开始', 'success');
      return api('GET', '/api/projects/' + encodeURIComponent(state.pid)).then(function (data) {
        state.project = data ? data.project : state.project;
        state.runs = (data && data.runs) ? data.runs : [];
        renderProjectHeader();
        renderRunList();
        return attachRun(runId, 'project');
      });
    })
    .catch(function (err) {
      toast('启动失败：' + err.message, 'error');
    })
    .then(function () {
      busy(false);
    });
}

/* 暂停 / 继续：调用后端接口并把状态同步到界面 */
function controlRun(action) {
  var rid = state.runId || (state.run && state.run.id);
  if (!rid) { toast('当前没有正在进行的测试', 'error'); return; }

  var btns = document.querySelectorAll('[data-act="pause-run"],[data-act="resume-run"]');
  for (var i = 0; i < btns.length; i++) btns[i].disabled = true;

  api('POST', '/api/runs/' + encodeURIComponent(rid) + '/' + action).then(function (res) {
    if (state.run && state.run.id === rid) {
      state.run.status = (res && res.status) || (action === 'pause' ? 'paused' : 'running');
      if (state.run.status === 'paused') state.run._pausedAt = Date.now();
      else state.run._pausedAt = null;
    }
    toast(action === 'pause'
      ? '已暂停，当前题目跑完后停下'
      : '已继续，接着跑剩下的题目', 'success');
    // 暂停后 SSE 仍连着，状态靠后端事件回推；这里先本地刷新一次
    if (state.view === 'run') renderRunView();
    else renderProgressCard();
  }).catch(function (err) {
    toast((action === 'pause' ? '暂停失败：' : '继续失败：') + err.message, 'error');
    for (var j = 0; j < btns.length; j++) btns[j].disabled = false;
  });
}

/* 停止：结束本轮，已完成的结果保留 */
function stopRun() {
  var rid = state.runId || (state.run && state.run.id);
  if (!rid) { toast('当前没有正在进行的测试', 'error'); return; }
  if (!window.confirm('确定停止本轮测试吗？\n已完成题目的结果与截图都会保留，未跑完的题目不再执行。')) return;

  api('POST', '/api/runs/' + encodeURIComponent(rid) + '/stop').then(function (res) {
    toast('已停止本轮测试，已完成 ' + ((res && res.okCount) || 0) + ' 题', 'success');
  }).catch(function (err) {
    toast('停止失败：' + err.message, 'error');
  });
}

/* 空状态里点「开始本轮测试」时，把用户带到真正可点的运行按钮：
   宽屏定位到项目头部按钮并高亮；窄屏按钮在常驻顶栏，直接回到页面顶部即可 */
function focusRunButton() {
  var btn = document.querySelector('.project-header [data-act="start-run"]');
  var hidden = !btn || btn.offsetParent === null;
  if (hidden) {
    var bar = document.querySelector('.mobile-bar');
    if (bar && bar.offsetParent !== null) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      var mob = document.querySelector('.mobile-run');
      if (mob) {
        mob.classList.add('btn-flash');
        setTimeout(function () { mob.classList.remove('btn-flash'); }, 1600);
      }
      return;
    }
  }
  if (!btn) return;
  btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  btn.classList.add('btn-flash');
  setTimeout(function () { btn.classList.remove('btn-flash'); }, 1600);
}

/* ------------------------------------------------------------
 * 删除操作
 * ---------------------------------------------------------- */

function deleteProject() {
  if (!state.pid || !state.project) return;
  var name = state.project.name || '该项目';
  if (!window.confirm('确定删除项目「' + name + '」吗？\n该项目下的所有测试轮次与报告都会一并删除，且不可恢复。')) return;

  api('DELETE', '/api/projects/' + encodeURIComponent(state.pid)).then(function () {
    toast('项目已删除', 'success');
    closeLive();
    state.pid = null;
    state.project = null;
    state.runs = [];
    state.run = null;
    state.runId = null;
    return loadState();
  }).catch(function (err) { toast('删除失败：' + err.message, 'error'); });
}

function deleteRun(rid) {
  if (!rid) return;

  // 运行中的轮次走「停止」语义：DELETE 对活动轮次只停止并保留结果，
  // 直接在界面上说清楚，避免用户以为删掉了却还在列表里
  var target = (state.run && state.run.id === rid) ? state.run
    : state.runs.filter(function (r) { return r.id === rid; })[0];
  if (isRunActive(target)) {
    if (!window.confirm('第 ' + runLabel(rid) + '正在运行中。\n要先停止它吗？已完成的结果会保留，之后可再删除。')) return;
    api('POST', '/api/runs/' + encodeURIComponent(rid) + '/stop').then(function (res) {
      toast('已停止，已完成 ' + ((res && res.okCount) || 0) + ' 题', 'success');
    }).catch(function (err) { toast('停止失败：' + err.message, 'error'); });
    return;
  }

  if (!window.confirm('确定删除第 ' + runLabel(rid) + ' 吗？删除后不可恢复。')) return;

  api('DELETE', '/api/runs/' + encodeURIComponent(rid)).then(function () {
    toast('轮次已删除', 'success');
    if (state.runId === rid) {
      closeLive();
      state.runId = null;
      state.run = null;
    }
    if (state.view === 'run') {
      showView('project');
      renderProgressCard();
    }
    return api('GET', '/api/projects/' + encodeURIComponent(state.pid)).then(function (data) {
      state.project = data ? data.project : state.project;
      state.runs = (data && data.runs) ? data.runs : [];
      renderProjectHeader();
      renderRunList();
      renderSidebar();
    });
  }).catch(function (err) { toast('删除失败：' + err.message, 'error'); });
}

function runLabel(rid) {
  var found = state.runs.filter(function (r) { return r.id === rid; })[0];
  if (found) return found.index + ' 轮测试';
  if (state.run && state.run.id === rid && state.run.index !== undefined) return state.run.index + ' 轮测试';
  return '该轮测试';
}

/* ------------------------------------------------------------
 * 重启浏览器
 * ---------------------------------------------------------- */

function restartChrome() {
  var btn = $('#btn-restart-chrome');
  if (btn) btn.disabled = true;
  api('POST', '/api/chrome/restart').then(function () {
    toast('已发送重启指令，正在重启受控浏览器…', 'success');
    setTimeout(function () { refreshChromeStatus(); }, 1500);
  }).catch(function (err) {
    toast('重启失败：' + err.message, 'error');
  }).then(function () {
    setTimeout(function () { if (btn) btn.disabled = false; }, 1500);
  });
}

/* ------------------------------------------------------------
 * 侧边栏（窄屏抽屉）
 * ---------------------------------------------------------- */

function closeSidebar() {
  document.body.classList.remove('sidebar-open');
}

/* ------------------------------------------------------------
 * 事件绑定（统一委托）
 * ---------------------------------------------------------- */

function bindEvents() {
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!el) return;
    var act = el.getAttribute('data-act');

    switch (act) {
      case 'modal-backdrop':
        if (ev.target === el) closeModal();
        break;

      case 'close-modal':
        closeModal();
        break;

      case 'submit-modal':
        submitProjectModal(el.getAttribute('data-mode') || 'create');
        break;

      case 'new-project':
        openProjectModal('create');
        break;

      case 'open-settings':
        openSettingsModal();
        break;

      case 'save-settings':
        saveSettings();
        break;

      case 'test-settings':
        testSettings();
        break;

      case 'clear-ai-key':
        clearAiKey();
        break;

      case 'edit-project':
      case 'rename-project':
        if (!state.project) return;
        openProjectModal('edit');
        break;

      case 'select-project':
        var pid = el.getAttribute('data-pid');
        if (pid && pid !== state.pid) selectProject(pid);
        else closeSidebar();
        break;

      case 'copy-url':
        if (!state.project || !state.project.url) { toast('该项目还没有填写网址', 'error'); return; }
        copyText(state.project.url).then(function (ok) {
          toast(ok ? '网址已复制到剪贴板' : '复制失败，请手动选择复制', ok ? 'success' : 'error');
        });
        break;

      case 'save-config':
        saveConfig();
        break;

      case 'start-run':
        startRun();
        break;

      case 'focus-run':
        focusRunButton();
        break;

      case 'pause-run':
        controlRun('pause');
        break;

      case 'resume-run':
        controlRun('resume');
        break;

      case 'stop-run':
        stopRun();
        break;

      case 'delete-project':
        deleteProject();
        break;

      case 'download-summary':
        if (!state.pid) return;
        triggerDownload('/api/projects/' + encodeURIComponent(state.pid) + '/report.docx');
        toast('正在生成项目汇总报告…');
        break;

      case 'open-run':
        openRunView(el.getAttribute('data-rid'));
        break;

      case 'download-run':
        triggerDownload('/api/runs/' + encodeURIComponent(el.getAttribute('data-rid')) + '/report.docx');
        toast('正在生成本轮 Word 报告…');
        break;

      case 'delete-run':
        deleteRun(el.getAttribute('data-rid'));
        break;

      case 'download-current-run':
        if (!state.runId) return;
        triggerDownload('/api/runs/' + encodeURIComponent(state.runId) + '/report.docx');
        toast('正在生成本轮 Word 报告…');
        break;

      case 'delete-current-run':
        deleteRun(state.runId);
        break;

      case 'toggle-row':
        toggleRow(el.getAttribute('data-index'));
        break;

      case 'back-to-project':
        if (state.pid) selectProject(state.pid);
        else showView('empty');
        break;

      case 'open-sidebar':
        document.body.classList.add('sidebar-open');
        break;

      case 'close-sidebar':
        closeSidebar();
        break;

      case 'restart-chrome':
        restartChrome();
        break;

      default:
        if (!handleAigenAction(act, el)) handleQbankAction(act, el);
        break;
    }
  });

  /* 勾选 / 取消勾选某个问题 → 同步到 textarea */
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (!t || !t.matches || !t.matches('input[data-q]')) return;
    var root = t.closest('[data-qbank]');
    if (!root) return;
    var ta = $(root.getAttribute('data-target'));
    if (!ta) return;
    var q = t.getAttribute('data-q');
    var list = parseQuestions(ta.value);
    if (t.checked) {
      if (list.indexOf(q) === -1) list.push(q);
    } else {
      list = list.filter(function (x) { return x !== q; });
    }
    ta.value = list.join('\n');
    syncQbank(root);
  });

  /* 手动编辑 textarea → 反向刷新勾选状态 */
  document.addEventListener('input', function (ev) {
    var t = ev.target;
    if (!t || t.tagName !== 'TEXTAREA' || !t.id) return;
    syncQbankByTarget('#' + t.id);
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      closeModal();
      closeSidebar();
    }
  });
}

/* ------------------------------------------------------------
 * 启动
 * ---------------------------------------------------------- */

function init() {
  bindEvents();
  showView('empty');
  // 问题库与 AI 配置并行拉取，都就绪后再渲染，避免渲染时状态缺失
  Promise.all([
    api('GET', '/api/ai/status').catch(function () { return { configured: false }; }),
    api('GET', '/api/question-bank').catch(function () { return null; })
  ]).then(function (res) {
    state.ai = res[0];
    state.bank = res[1];
    return loadState();
  });
  refreshChromeStatus();
  setInterval(tickElapsed, 1000);
  setInterval(refreshChromeStatus, 20000);
}

init();
