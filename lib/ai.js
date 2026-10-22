/**
 * DeepSeek 模型调用（用于「AI 生成测试问题」）
 *
 * 密钥来源优先级：
 *   1) 环境变量 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_MODEL
 *   2) data/settings.json（在页面上填写后保存）
 */
const fs = require('fs');
const path = require('path');
const CFG = require('./config');

const SETTINGS_FILE = path.join(CFG.DATA_DIR, 'settings.json');
const DEFAULT_BASE = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';

function readSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return {};
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {};
  } catch { return {}; }
}

function writeSettings(patch) {
  const cur = readSettings();
  const next = { ...cur, ...patch };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function aiConfig() {
  const s = readSettings();
  const envKey = process.env.DEEPSEEK_API_KEY || '';
  return {
    apiKey: envKey || s.apiKey || '',
    baseUrl: (process.env.DEEPSEEK_BASE_URL || s.baseUrl || DEFAULT_BASE).replace(/\/+$/, ''),
    model: process.env.DEEPSEEK_MODEL || s.model || DEFAULT_MODEL,
    source: envKey ? 'env' : (s.apiKey ? 'settings' : null),
  };
}

function maskKey(k) {
  if (!k) return '';
  if (k.length <= 12) return k.slice(0, 3) + '****';
  return k.slice(0, 6) + '****' + k.slice(-4);
}

function status() {
  const c = aiConfig();
  return {
    configured: !!c.apiKey,
    keyMasked: maskKey(c.apiKey),
    baseUrl: c.baseUrl,
    model: c.model,
    source: c.source,
  };
}

/* ---------------- 调用 ---------------- */
async function chat(messages, opts = {}) {
  const c = aiConfig();
  if (!c.apiKey) {
    const e = new Error('尚未配置 DeepSeek API Key，请先在页面上填写');
    e.code = 400;
    throw e;
  }
  const body = {
    model: c.model,
    messages,
    temperature: opts.temperature === undefined ? 0.8 : opts.temperature,
    max_tokens: opts.maxTokens || 1200,
    stream: false,
  };
  if (opts.json) body.response_format = { type: 'json_object' };

  let res;
  try {
    res = await fetch(c.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + c.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeout || 90000),
    });
  } catch (err) {
    const e = new Error('无法连接模型服务（' + c.baseUrl + '）：' + (err.name === 'TimeoutError' ? '请求超时' : err.message));
    e.code = 502;
    throw e;
  }

  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try { const j = JSON.parse(text); if (j.error && j.error.message) msg = j.error.message; } catch { }
    const e = new Error('模型服务返回 ' + res.status + '：' + msg);
    e.code = res.status === 401 ? 401 : 502;
    throw e;
  }
  let data;
  try { data = JSON.parse(text); } catch { const e = new Error('模型返回内容无法解析'); e.code = 502; throw e; }
  const content = data.choices && data.choices[0] && data.choices[0].message
    ? (data.choices[0].message.content || '') : '';
  return { content, usage: data.usage || null, model: data.model || c.model };
}

/* ---------------- 生成测试问题 ---------------- */
function cleanQuestion(s) {
  return String(s || '')
    .replace(/^\s*(?:\d+[.、)）]|[-*•])\s*/, '')   // 去掉序号/项目符号
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')          // 去掉首尾引号
    .replace(/\s+/g, ' ')
    .trim();
}

/* 过滤模型的开场白、客套话、总结语，这些不是问题 */
function isChatter(q) {
  if (/^(好的|当然|可以|以下是|下面是|如下|为您|这里|希望|以上|另外|注意|备注|这些|总共|共计|综上|首先|最后)/.test(q)
    && /[，,：:、\s]/.test(q.slice(2, 3) || ' ')) return true;
  if (/[：:]$/.test(q)) return true;                       // 以冒号结尾，通常是引导语
  if (/^(希望|如有|如果有|祝|感谢|若|如需|仅供参考)/.test(q)) return true;
  if (/[。！!]$/.test(q) && !/[？?]/.test(q) && q.length < 16) return true;  // 短陈述句
  return false;
}

function parseQuestions(content, count) {
  let list = [];
  // 优先按 JSON 解析
  const jsonMatch = String(content).match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const arr = Array.isArray(obj) ? obj : (obj.questions || obj.list || obj.items);
      if (Array.isArray(arr)) list = arr.map(x => (typeof x === 'string' ? x : (x && x.question) || ''));
    } catch { /* 落到按行解析 */ }
  }
  if (!list.length) {
    list = String(content).split(/\r?\n/).map(cleanQuestion).filter(Boolean);
  }
  const seen = {};
  const out = [];
  for (let q of list) {
    q = cleanQuestion(q);
    if (!q || q.length < 4) continue;
    if (isChatter(q)) continue;
    if (!/[？?]/.test(q) && q.length < 10) continue;      // 既无问号又很短，多半不是问题
    const key = q.replace(/[\s，。？?！!、,.]/g, '');
    if (seen[key]) continue;
    seen[key] = 1;
    out.push(q);
  }
  return out.slice(0, count);
}

async function generateQuestions({ keyword, count = 5, existing = [], domain = '图书馆' }) {
  const kw = String(keyword || '').trim();
  if (!kw) { const e = new Error('请输入一个关键词或问题'); e.code = 400; throw e; }
  const n = Math.max(1, Math.min(20, Number(count) || 5));

  const avoid = (Array.isArray(existing) ? existing : [])
    .map(s => String(s).trim()).filter(Boolean).slice(0, 60);

  const sys = '你是' + domain + '智能问答机器人（AI 馆员）的测试工程师，擅长站在真实读者视角设计测试问题。'
    + '你设计的问题具体、口语化、可回答、彼此角度不同，用于评测问答机器人的知识覆盖与回答质量。';

  const user = [
    '参考主题：' + kw,
    '',
    '请围绕该主题生成 ' + n + ' 个测试问题，用于向' + domain + 'AI 馆员提问。要求：',
    '1. 必须是读者会真实问出口的自然口语化问句（以问号结尾），不要写成标题、名词短语或指令；',
    '2. ' + n + ' 个问题要覆盖不同角度，例如：具体规则、办理流程、位置地点、可用渠道、时间期限、费用标准、特殊与边界情况；',
    '3. 问题要具体到可以明确判断回答是否准确，避免"介绍一下图书馆"这类过于宽泛的问法；',
    '4. 不要出现编号、解释、前后缀说明。',
    avoid.length ? '5. 不要与以下已存在问题重复或高度近似：\n' + avoid.map(s => '- ' + s).join('\n') : '',
    '',
    '只返回 JSON，格式为：{"questions": ["问题1", "问题2"]}',
  ].filter(Boolean).join('\n');

  const r = await chat([
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ], { json: true, temperature: 0.9, maxTokens: 1500 });

  let questions = parseQuestions(r.content, n);
  // JSON 模式偶尔会退化，重试一次纯文本模式
  if (questions.length < Math.min(3, n)) {
    const r2 = await chat([
      { role: 'system', content: sys },
      { role: 'user', content: user.replace(/只返回 JSON[\s\S]*$/, '每行输出一个问题，共 ' + n + ' 行，不要编号，不要任何其他内容。') },
    ], { temperature: 0.9, maxTokens: 1500 });
    questions = parseQuestions(r2.content, n);
  }
  if (!questions.length) {
    const e = new Error('模型没有返回可用的问题，请换个关键词再试');
    e.code = 502;
    throw e;
  }
  return { questions, model: r.model, usage: r.usage };
}

/* ---------------- 连通性测试 ---------------- */
async function testConnection() {
  const c = aiConfig();
  if (!c.apiKey) return { ok: false, error: '尚未配置 API Key' };
  try {
    const r = await chat([{ role: 'user', content: '回复两个字：正常' }], { maxTokens: 20, temperature: 0, timeout: 30000 });
    return { ok: true, model: r.model, reply: (r.content || '').trim().slice(0, 40) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { status, aiConfig, generateQuestions, testConnection, writeSettings, readSettings, chat };
