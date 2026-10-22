const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

const CHROME_CANDIDATES = [
  // 显式指定优先(README 已文档化该环境变量; 容器/非默认安装路径依赖它)
  process.env.AI_TESTER_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  // Linux 常见路径(容器内为 /usr/bin/chromium)
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { if (p && fs.existsSync(p)) return p; } catch { }
  }
  return null;
}

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');

const CFG = {
  ROOT,
  PORT: Number(process.env.PORT || 3789),
  CDP_PORT: Number(process.env.CDP_PORT || 9333),
  DATA_DIR,
  RUNS_DIR: path.join(DATA_DIR, 'runs'),
  SHOTS_DIR: path.join(DATA_DIR, 'shots'),
  PUBLIC_DIR: path.join(ROOT, 'public'),
  // 允许隔离出独立的浏览器配置目录，便于并行跑测试而不干扰正在使用的实例
  PROFILE_DIR: process.env.PROFILE_DIR ? path.resolve(process.env.PROFILE_DIR) : path.join(ROOT, 'chrome-profile'),
  DB_FILE: path.join(DATA_DIR, 'db.json'),
  CHROME: findChrome(),
  UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  VIEWPORT: { width: 1440, height: 960 },
  ANSWER_TIMEOUT_SEC: Number(process.env.ANSWER_TIMEOUT || 180),
  MAX_ATTEMPTS: 3,
  VERSION: '1.0.0',
};

for (const d of [CFG.DATA_DIR, CFG.RUNS_DIR, CFG.SHOTS_DIR, CFG.PROFILE_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch { }
}

module.exports = CFG;
