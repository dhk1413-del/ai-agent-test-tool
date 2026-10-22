const fs = require('fs');
const path = require('path');
const CFG = require('./config');

function rid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function emptyDb() { return { projects: [], runs: [] }; }

function readDb() {
  try {
    if (!fs.existsSync(CFG.DB_FILE)) return emptyDb();
    const d = JSON.parse(fs.readFileSync(CFG.DB_FILE, 'utf8'));
    if (!d.projects) d.projects = [];
    if (!d.runs) d.runs = [];
    return d;
  } catch { return emptyDb(); }
}

function writeDb(db) {
  const tmp = CFG.DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, CFG.DB_FILE);
}

// ---------- 项目 ----------
function listProjects() {
  const db = readDb();
  return db.projects
    .map(p => withStats(p, db.runs))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function withStats(p, runs) {
  const mine = runs.filter(r => r.projectId === p.id);
  const sorted = mine.slice().sort((a, b) => (b.index || 0) - (a.index || 0));
  return { ...p, runCount: mine.length, lastRunAt: sorted[0] ? sorted[0].startedAt : null };
}

function getProject(id) {
  const db = readDb();
  const p = db.projects.find(x => x.id === id);
  return p ? withStats(p, db.runs) : null;
}

function createProject({ name, url, questions }) {
  const db = readDb();
  const now = new Date().toISOString();
  const p = {
    id: rid('p'),
    name: String(name || '未命名项目').slice(0, 120),
    url: String(url || '').trim(),
    questions: normalizeQuestions(questions),
    createdAt: now,
    updatedAt: now,
  };
  db.projects.push(p);
  writeDb(db);
  return withStats(p, db.runs);
}

function updateProject(id, patch) {
  const db = readDb();
  const p = db.projects.find(x => x.id === id);
  if (!p) return null;
  if (patch.name !== undefined) p.name = String(patch.name).slice(0, 120);
  if (patch.url !== undefined) p.url = String(patch.url).trim();
  if (patch.questions !== undefined) p.questions = normalizeQuestions(patch.questions);
  p.updatedAt = new Date().toISOString();
  writeDb(db);
  return withStats(p, db.runs);
}

function deleteProject(id) {
  const db = readDb();
  const runs = db.runs.filter(r => r.projectId === id);
  db.projects = db.projects.filter(x => x.id !== id);
  db.runs = db.runs.filter(r => r.projectId !== id);
  writeDb(db);
  for (const r of runs) {
    try { fs.rmSync(path.join(CFG.RUNS_DIR, r.id + '.json'), { force: true }); } catch { }
    try { fs.rmSync(path.join(CFG.SHOTS_DIR, r.id), { recursive: true, force: true }); } catch { }
  }
  return true;
}

function normalizeQuestions(q) {
  let arr = [];
  if (Array.isArray(q)) arr = q;
  else if (typeof q === 'string') arr = q.split(/\r?\n/);
  return arr.map(s => String(s).trim()).filter(Boolean);
}

// ---------- 轮次 ----------
function listRuns(projectId) {
  const db = readDb();
  return db.runs
    .filter(r => r.projectId === projectId)
    .sort((a, b) => (b.index || 0) - (a.index || 0));
}

function runSummary(r) {
  const { results, progress, engine, ...rest } = r;
  return rest;
}

function getRun(id) {
  const db = readDb();
  const meta = db.runs.find(r => r.id === id);
  if (!meta) return null;
  const full = readRunFile(id);
  if (!full) return { ...meta, results: [], progress: null, engine: null };
  return { ...meta, results: full.results || [], progress: full.progress || null, engine: full.engine || null };
}

function readRunFile(id) {
  try {
    const f = path.join(CFG.RUNS_DIR, id + '.json');
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch { return null; }
}

function writeRunFile(id, data) {
  const f = path.join(CFG.RUNS_DIR, id + '.json');
  fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8');
}

function createRun(projectId) {
  const db = readDb();
  const prev = db.runs.filter(r => r.projectId === projectId);
  const index = prev.reduce((m, r) => Math.max(m, r.index || 0), 0) + 1;
  const run = {
    id: rid('r'),
    projectId,
    index,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    total: 0,
    okCount: 0,
    avgSec: null,
    error: null,
  };
  db.runs.push(run);
  writeDb(db);
  writeRunFile(run.id, { progress: null, engine: null, results: [] });
  return run;
}

function updateRun(id, patch) {
  const db = readDb();
  const r = db.runs.find(x => x.id === id);
  if (!r) return null;
  Object.assign(r, patch);
  writeDb(db);
  return r;
}

function saveRunData(id, data) {
  const cur = readRunFile(id) || { results: [], progress: null, engine: null };
  writeRunFile(id, { ...cur, ...data });
}

function appendResult(id, result) {
  const cur = readRunFile(id) || { results: [], progress: null, engine: null };
  const results = (cur.results || []).filter(r => r.index !== result.index);
  results.push(result);
  results.sort((a, b) => a.index - b.index);
  writeRunFile(id, { ...cur, results });
}

function deleteRun(id) {
  const db = readDb();
  db.runs = db.runs.filter(r => r.id !== id);
  writeDb(db);
  try { fs.rmSync(path.join(CFG.RUNS_DIR, id + '.json'), { force: true }); } catch { }
  try { fs.rmSync(path.join(CFG.SHOTS_DIR, id), { recursive: true, force: true }); } catch { }
  return true;
}

module.exports = {
  readDb, writeDb, listProjects, getProject, createProject, updateProject, deleteProject,
  listRuns, getRun, createRun, updateRun, saveRunData, appendResult, deleteRun, runSummary, normalizeQuestions,
};
