/**
 * Word 测试报告生成
 *  - buildRunReport      单轮报告（逐题原文 + 截图）
 *  - buildProjectReport  项目多轮汇总报告（含轮次趋势）
 */
const fs = require('fs');
const path = require('path');
const { deriveSource, SOURCE_COLORS } = require('./robot');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType, PageBreak, ImageRun,
} = require('docx');

const FONT = '微软雅黑';
const ACCENT = '1F3864';

/* ---------------- 来源（问答库=蓝 / 单位知识库=绿 / 其他=红）---------------- */

/**
 * 取某题的来源。新数据直接带 r.source；旧数据只有 attribution，
 * 这里现场再判一次，保证老轮次导出也显示来源。
 */
function sourceOf(r) {
  if (r && r.source && r.source.category) return r.source;
  return deriveSource({
    attribution: (r && r.attribution) || '',
    recall: (r && r.recall) || '',
    recallTitles: (r && r.recallTitles) || [],
    answer: (r && r.answer) || '',
  });
}

/** 「该答案来自：X」——按类别着色 */
function sourceParagraph(r, extra = {}) {
  const s = sourceOf(r);
  const color = SOURCE_COLORS[s.category] || SOURCE_COLORS.other;
  const label = sourceDisplayLabel(r, s);
  return new Paragraph({
    spacing: { after: extra.after === undefined ? 60 : extra.after, line: 300 },
    indent: extra.indent,
    children: [
      new TextRun({ text: '该答案来自：', bold: true, font: FONT, size: 21, color: '333333' }),
      new TextRun({ text: label, bold: true, font: FONT, size: 21, color }),
    ],
  });
}

/** 来源显示名：没有明确「内容来自：X」时给出人话兜底 */
function sourceDisplayLabel(r, s) {
  const src = s || sourceOf(r);
  if (src.label && src.label.trim()) return src.label.trim();
  if (src.category === 'other') {
    return (r && r.attribution) ? '大模型通用回答（未命中知识库）' : '未标注';
  }
  return src.category === 'qa' ? '问答库' : '单位知识库';
}

/** 汇总各来源题数，用于概述与结果分析 */
function sourceStats(results) {
  const acc = { qa: 0, unit: 0, other: 0 };
  (results || []).forEach(r => {
    const c = sourceOf(r).category;
    acc[c] = (acc[c] || 0) + 1;
  });
  return acc;
}


const P = (text, o = {}) => new Paragraph({
  spacing: { after: o.after === undefined ? 100 : o.after, line: 300 },
  alignment: o.align,
  indent: o.indent,
  children: [new TextRun({
    text: String(text == null ? '' : text), bold: !!o.bold, italics: !!o.italics,
    size: o.size || 21, color: o.color || '000000', font: FONT,
  })],
});

const H = (text, level = HeadingLevel.HEADING_1) => new Paragraph({
  heading: level,
  spacing: { before: 260, after: 140 },
  children: [new TextRun({ text, bold: true, font: FONT, size: level === HeadingLevel.HEADING_1 ? 30 : 24, color: ACCENT })],
});

const cell = (text, { bold = false, width, shade, color = '000000', align } = {}) => new TableCell({
  width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
  shading: shade ? { type: ShadingType.CLEAR, fill: shade } : undefined,
  margins: { top: 60, bottom: 60, left: 100, right: 100 },
  children: (Array.isArray(text) ? text : [text]).map(t => new Paragraph({
    alignment: align, spacing: { after: 0, line: 280 },
    children: [new TextRun({ text: String(t == null ? '' : t), bold, font: FONT, size: 20, color })],
  })),
});

const table = (rows) => new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  borders: {
    top: { style: BorderStyle.SINGLE, size: 4, color: 'AAAAAA' },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: 'AAAAAA' },
    left: { style: BorderStyle.SINGLE, size: 4, color: 'AAAAAA' },
    right: { style: BorderStyle.SINGLE, size: 4, color: 'AAAAAA' },
    insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'DDDDDD' },
    insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'DDDDDD' },
  },
  rows,
});

function pic(file, w = 600) {
  try {
    if (!file || !fs.existsSync(file)) return P('（截图缺失）', { color: 'B00020', align: AlignmentType.CENTER });
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 120, after: 160 },
      children: [new ImageRun({ type: 'png', data: fs.readFileSync(file), transformation: { width: w, height: Math.round(w * 960 / 1440) } })],
    });
  } catch {
    return P('（截图读取失败）', { color: 'B00020', align: AlignmentType.CENTER });
  }
}

/* ---------------- 逐题详情（截图与问答合并在一起，先截图）---------------- */

/**
 * 输出一题的完整内容：
 *   标题 → 页面截图 → 提问/耗时/来源 → AI 回答 →（可选）检索过程
 * @param {object} r            单题结果
 * @param {object} opt
 *   shotFile   截图绝对路径
 *   picWidth   截图宽度
 *   withFlow   是否输出「检索过程」
 */
function questionBlock(r, { shotFile, picWidth = 600, withFlow = true } = {}) {
  const out = [];

  out.push(new Paragraph({
    spacing: { before: 300, after: 110 },
    children: [new TextRun({
      text: `第 ${r.index} 题　${r.question || ''}`,
      bold: true, size: 23, font: FONT, color: ACCENT,
    })],
  }));

  // 1) 先放页面截图
  out.push(P('页面截图：', { bold: true, size: 20, color: '555555', after: 60 }));
  out.push(shotFile ? pic(shotFile, picWidth) : P('（无截图）', { color: 'B00020', align: AlignmentType.CENTER }));

  // 2) 再看问答本身
  const s = sourceOf(r);
  out.push(table([
    new TableRow({ children: [cell('提问', { bold: true, shade: 'F2F2F2', width: 14 }), cell(r.question || '')] }),
    new TableRow({
      children: [cell('响应耗时', { bold: true, shade: 'F2F2F2', width: 14 }),
      cell(r.elapsedSec == null ? '—' : `${r.elapsedSec} 秒（${r.sendTime || ''} 发出，${r.answerTime || ''} 完成）`)],
    }),
    new TableRow({
      children: [cell('回答来源', { bold: true, shade: 'F2F2F2', width: 14 }),
      cell([new Paragraph({
        spacing: { after: 0, line: 280 },
        children: [
          new TextRun({ text: sourceDisplayLabel(r, s), bold: true, font: FONT, size: 20, color: SOURCE_COLORS[s.category] || SOURCE_COLORS.other }),
          s.raw ? new TextRun({ text: `（页面署名：${s.raw}）`, font: FONT, size: 18, color: '888888' }) : '',
        ].filter(Boolean),
      })],
      )],
    }),
  ]));
  out.push(P('', { after: 60 }));

  if (r.card && !(r.answer || '').trim()) {
    out.push(P('AI 回答（卡片型组件，见上方截图）：', { bold: true, after: 80 }));
    if (r.note) out.push(P(r.note, { indent: { left: 240 }, after: 100 }));
  } else {
    out.push(P('AI 回答：', { bold: true, after: 80 }));
    const ans = (r.answer || '').trim();
    if (!ans) {
      out.push(P(r.note || '（本题未取得有效回答）', { color: 'B00020', indent: { left: 240 } }));
    } else {
      ans.split(/\n+/).map(x => x.trim()).filter(Boolean).forEach(line =>
        out.push(P(line, { indent: { left: 240 }, after: 70 })));
    }
  }

  if (withFlow && r.flow) {
    const flow = r.flow.replace(/运行完成|展开|收起/g, '').trim();
    if (flow) {
      out.push(P('检索过程：', { bold: true, after: 60, size: 20, color: '555555' }));
      out.push(P(flow, { size: 20, color: '555555', indent: { left: 240 } }));
    }
  }

  // 3) 来源放在每题的问答详情里
  out.push(sourceParagraph(r, { indent: { left: 240 } }));

  return out;
}

/** 来源分布表 */
function sourceTable(results) {
  const st = sourceStats(results);
  const total = (results || []).length;
  const rows = [new TableRow({
    tableHeader: true,
    children: [
      cell('来源', { bold: true, shade: 'EAF1FB', width: 30, align: AlignmentType.CENTER }),
      cell('题数', { bold: true, shade: 'EAF1FB', width: 20, align: AlignmentType.CENTER }),
      cell('占比', { bold: true, shade: 'EAF1FB', width: 20, align: AlignmentType.CENTER }),
      cell('颜色标识', { bold: true, shade: 'EAF1FB', width: 30, align: AlignmentType.CENTER }),
    ],
  })];
  [['qa', '问答库'], ['unit', '单位知识库'], ['other', '其他']].forEach(([k, name]) => {
    const n = st[k] || 0;
    rows.push(new TableRow({
      children: [
        cell(name, { align: AlignmentType.CENTER, color: SOURCE_COLORS[k], bold: true }),
        cell(String(n), { align: AlignmentType.CENTER }),
        cell(total ? Math.round(n / total * 100) + '%' : '—', { align: AlignmentType.CENTER }),
        cell(k === 'qa' ? '蓝色' : k === 'unit' ? '绿色' : '红色', { align: AlignmentType.CENTER, color: SOURCE_COLORS[k] }),
      ],
    }));
  });
  return table(rows);
}

const fmt = (iso) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); } catch { return String(iso); }
};

function stats(run) {
  const rs = run.results || [];
  const ok = rs.filter(r => r.completed).length;
  const secs = rs.map(r => r.elapsedSec).filter(v => typeof v === 'number');
  return {
    total: rs.length || run.total || 0,
    ok,
    cards: rs.filter(r => r.card).length,
    avg: secs.length ? Math.round(secs.reduce((a, b) => a + b, 0) / secs.length) : null,
    min: secs.length ? Math.min(...secs) : null,
    max: secs.length ? Math.max(...secs) : null,
    sum: secs.reduce((a, b) => a + b, 0),
  };
}

function overviewTable(project, run, st) {
  return table([
    new TableRow({ children: [cell('项目', { bold: true, shade: 'EAF1FB', width: 22 }), cell('内容', { bold: true, shade: 'EAF1FB' })] }),
    new TableRow({ children: [cell('被测对象'), cell(project.name)] }),
    new TableRow({ children: [cell('访问地址'), cell(project.url)] }),
    new TableRow({ children: [cell('测试轮次'), cell(`第 ${run.index} 轮`) ] }),
    new TableRow({ children: [cell('测试时间'), cell(`${fmt(run.startedAt)} ~ ${run.finishedAt ? fmt(run.finishedAt) : '进行中'}`)] }),
    new TableRow({ children: [cell('测试题量'), cell(`${st.total} 题（成功 ${st.ok} 题，成功率 ${st.total ? Math.round(st.ok / st.total * 100) : 0}%）`)] }),
    new TableRow({ children: [cell('响应耗时'), cell(st.avg === null ? '—' : `平均 ${st.avg} 秒／最快 ${st.min} 秒／最慢 ${st.max} 秒，合计约 ${st.sum} 秒`)] }),
    new TableRow({ children: [cell('回答形态'), cell(`文字型 ${st.total - st.cards} 题，卡片型 ${st.cards} 题`)] }),
    new TableRow({ children: [cell('测试方式'), cell('浏览器自动化真实交互：逐题提问，每题先点击「新建对话」开启新会话，待上一题回答完毕后再问下一题')] }),
  ]);
}

function resultsTable(run) {
  const rows = [new TableRow({
    tableHeader: true,
    children: [
      cell('序号', { bold: true, shade: 'EAF1FB', width: 8, align: AlignmentType.CENTER }),
      cell('测试问题', { bold: true, shade: 'EAF1FB', width: 50 }),
      cell('耗时(秒)', { bold: true, shade: 'EAF1FB', width: 12, align: AlignmentType.CENTER }),
      cell('字数', { bold: true, shade: 'EAF1FB', width: 12, align: AlignmentType.CENTER }),
      cell('结果', { bold: true, shade: 'EAF1FB', width: 18, align: AlignmentType.CENTER }),
    ],
  })];
  (run.results || []).forEach(r => {
    rows.push(new TableRow({
      children: [
        cell(String(r.index), { align: AlignmentType.CENTER }),
        cell(r.question),
        cell(r.elapsedSec == null ? '—' : String(r.elapsedSec), { align: AlignmentType.CENTER }),
        cell(r.card ? '卡片' : String((r.answer || '').length), { align: AlignmentType.CENTER }),
        cell(r.completed ? (r.card ? '卡片型返回' : '正常返回') : '异常/无回答', {
          align: AlignmentType.CENTER, color: r.completed ? '1E7B34' : 'B00020',
        }),
      ],
    }));
  });
  return table(rows);
}

/* ---------------- 单轮报告 ---------------- */
async function buildRunReport({ project, run, shotsDir }) {
  const st = stats(run);
  const c = [];

  c.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { before: 1200, after: 120 },
    children: [new TextRun({ text: project.name, bold: true, size: 40, font: FONT, color: ACCENT })],
  }));
  c.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 300 },
    children: [new TextRun({ text: `AI 问答测试报告（第 ${run.index} 轮）`, bold: true, size: 34, font: FONT, color: ACCENT })],
  }));
  c.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { before: 1600 },
    children: [new TextRun({ text: `报告生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`, size: 22, font: FONT })],
  }));
  c.push(new Paragraph({ children: [new PageBreak()] }));

  c.push(H('一、测试概述'));
  c.push(overviewTable(project, run, st));
  c.push(P(''));
  c.push(H('二、测试结果总览'));
  c.push(resultsTable(run));
  c.push(P(''));
  c.push(H('三、回答来源分布', HeadingLevel.HEADING_2));
  c.push(sourceTable(run.results));
  c.push(P('来源标识：问答库为蓝色，单位知识库为绿色，其他为红色。', { size: 19, color: '777777' }));
  c.push(P(''));

  c.push(H('四、逐题问答详情（含页面截图）'));
  (run.results || []).forEach((r, i) => {
    if (i > 0) c.push(new PageBreak());
    questionBlock(r, {
      shotFile: path.join(shotsDir, `q${String(r.index).padStart(2, '0')}.png`),
    }).forEach(p => c.push(p));
  });

  c.push(new PageBreak());
  c.push(H('五、结果分析'));
  const short = (run.results || []).filter(r => !r.card && (r.answer || '').trim() && (r.answer || '').trim().length < 120);
  const failed = (run.results || []).filter(r => !r.completed);
  const lines = [];
  lines.push(`本轮共提问 ${st.total} 题，成功返回 ${st.ok} 题，成功率 ${st.total ? Math.round(st.ok / st.total * 100) : 0}%。`);
  if (st.avg !== null) lines.push(`平均响应 ${st.avg} 秒，最快 ${st.min} 秒，最慢 ${st.max} 秒，全部题目合计约 ${st.sum} 秒。`);
  if (st.cards) lines.push(`其中 ${st.cards} 题以卡片型组件回答（非纯文本），已在正文中以页面截图形式留存。`);
  if (short.length) lines.push(`回答明显偏短（不足 120 字）的题目：第 ${short.map(r => r.index).join('、')} 题，建议人工复核其信息完整性。`);
  if (failed.length) lines.push(`未取得有效回答的题目：第 ${failed.map(r => r.index).join('、')} 题，需人工复核。`);
  lines.push('每题均通过点击「新建对话」开启独立会话后提问，各题上下文互不干扰，结果可独立评价。');
  const sc = sourceStats(run.results);
  const scTotal = sc.qa + sc.unit + sc.other;
  if (scTotal) {
    lines.push(`回答来源分布：问答库 ${sc.qa} 题、单位知识库 ${sc.unit} 题、其他 ${sc.other} 题。`);
    if (sc.qa) lines.push(`其中命中「问答库」的题目（蓝色标识）为：第 ${(run.results || []).filter(r => sourceOf(r).category === 'qa').map(r => r.index).join('、')} 题。`);
    if (sc.unit) lines.push(`命中「单位知识库」的题目（绿色标识）为：第 ${(run.results || []).filter(r => sourceOf(r).category === 'unit').map(r => r.index).join('、')} 题。`);
    if (sc.other) lines.push(`未命中任何知识库、由大模型直接作答的题目（红色标识）为：第 ${(run.results || []).filter(r => sourceOf(r).category === 'other').map(r => r.index).join('、')} 题，这类回答无馆方资料支撑，建议重点复核准确性。`);
  }
  lines.forEach(t => c.push(P(t)));

  return await Packer.toBuffer(new Document({
    styles: { default: { document: { run: { font: FONT, size: 21 } } } },
    sections: [{ properties: {}, children: c }],
  }));
}

/* ---------------- 项目多轮汇总报告 ---------------- */
async function buildProjectReport({ project, runs, shotsDirOf }) {
  const c = [];
  const sorted = runs.slice().sort((a, b) => (b.index || 0) - (a.index || 0));

  c.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { before: 1200, after: 120 },
    children: [new TextRun({ text: project.name, bold: true, size: 40, font: FONT, color: ACCENT })],
  }));
  c.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 300 },
    children: [new TextRun({ text: 'AI 问答多轮测试汇总报告', bold: true, size: 34, font: FONT, color: ACCENT })],
  }));
  c.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { before: 1600 },
    children: [new TextRun({ text: `共 ${sorted.length} 轮测试 · 报告生成于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`, size: 22, font: FONT })],
  }));
  c.push(new Paragraph({ children: [new PageBreak()] }));

  c.push(H('一、项目概况'));
  c.push(table([
    new TableRow({ children: [cell('项目', { bold: true, shade: 'EAF1FB', width: 22 }), cell('内容', { bold: true, shade: 'EAF1FB' })] }),
    new TableRow({ children: [cell('项目名称'), cell(project.name)] }),
    new TableRow({ children: [cell('访问地址'), cell(project.url)] }),
    new TableRow({ children: [cell('测试问题数'), cell(`${(project.questions || []).length} 题`)] }),
    new TableRow({ children: [cell('累计轮次'), cell(`${sorted.length} 轮`)] }),
    new TableRow({ children: [cell('最近测试'), cell(fmt(sorted[0] && sorted[0].startedAt))] }),
  ]));
  c.push(P(''));

  c.push(H('二、各轮次结果趋势'));
  const rows = [new TableRow({
    tableHeader: true,
    children: [
      cell('轮次', { bold: true, shade: 'EAF1FB', width: 12, align: AlignmentType.CENTER }),
      cell('开始时间', { bold: true, shade: 'EAF1FB', width: 26 }),
      cell('成功/总数', { bold: true, shade: 'EAF1FB', width: 18, align: AlignmentType.CENTER }),
      cell('成功率', { bold: true, shade: 'EAF1FB', width: 16, align: AlignmentType.CENTER }),
      cell('平均耗时', { bold: true, shade: 'EAF1FB', width: 16, align: AlignmentType.CENTER }),
      cell('状态', { bold: true, shade: 'EAF1FB', width: 12, align: AlignmentType.CENTER }),
    ],
  })];
  sorted.forEach(r => {
    const s = stats(r);
    rows.push(new TableRow({
      children: [
        cell('第 ' + r.index + ' 轮', { align: AlignmentType.CENTER }),
        cell(fmt(r.startedAt)),
        cell(`${s.ok} / ${s.total}`, { align: AlignmentType.CENTER }),
        cell(s.total ? Math.round(s.ok / s.total * 100) + '%' : '—', { align: AlignmentType.CENTER }),
        cell(s.avg === null ? '—' : s.avg + ' 秒', { align: AlignmentType.CENTER }),
        cell(r.status === 'done' ? '已完成' : r.status === 'running' ? '进行中' : '失败', {
          align: AlignmentType.CENTER, color: r.status === 'done' ? '1E7B34' : r.status === 'running' ? '1F5FBF' : 'B00020',
        }),
      ],
    }));
  });
  c.push(table(rows));
  c.push(P(''));

  const all = sorted.flatMap(r => r.results || []);
  const okAll = all.filter(r => r.completed).length;
  c.push(P(`累计执行 ${all.length} 次提问，成功返回 ${okAll} 次，整体成功率 ${all.length ? Math.round(okAll / all.length * 100) : 0}%。`, { after: 200 }));

  c.push(H('三、各轮次逐题结果'));
  sorted.forEach(r => {
    c.push(new Paragraph({
      spacing: { before: 280, after: 110 },
      children: [new TextRun({ text: `第 ${r.index} 轮（${fmt(r.startedAt)}）`, bold: true, size: 24, font: FONT, color: ACCENT })],
    }));
    const rr = [new TableRow({
      tableHeader: true,
      children: [
        cell('序号', { bold: true, shade: 'EAF1FB', width: 7, align: AlignmentType.CENTER }),
        cell('测试问题', { bold: true, shade: 'EAF1FB', width: 37 }),
        cell('耗时(秒)', { bold: true, shade: 'EAF1FB', width: 10, align: AlignmentType.CENTER }),
        cell('字数', { bold: true, shade: 'EAF1FB', width: 10, align: AlignmentType.CENTER }),
        cell('回答来源', { bold: true, shade: 'EAF1FB', width: 18, align: AlignmentType.CENTER }),
        cell('结果', { bold: true, shade: 'EAF1FB', width: 18, align: AlignmentType.CENTER }),
      ],
    })];
    (r.results || []).forEach(x => rr.push(new TableRow({
      children: [
        cell(String(x.index), { align: AlignmentType.CENTER }),
        cell(x.question),
        cell(x.elapsedSec == null ? '—' : String(x.elapsedSec), { align: AlignmentType.CENTER }),
        cell(x.card ? '卡片' : String((x.answer || '').length), { align: AlignmentType.CENTER }),
        cell(sourceDisplayLabel(x, sourceOf(x)), { align: AlignmentType.CENTER, color: SOURCE_COLORS[sourceOf(x).category] }),
        cell(x.completed ? (x.card ? '卡片型返回' : '正常返回') : '异常/无回答', {
          align: AlignmentType.CENTER, color: x.completed ? '1E7B34' : 'B00020',
        }),
      ],
    })));
    c.push(table(rr));
  });

  // 逐题横向对比（同一问题在历轮的耗时/字数变化）
  if (sorted.length > 1) {
    c.push(new PageBreak());
    c.push(H('四、同一问题的跨轮次对比'));
    const qs = (project.questions || []).length
      ? project.questions
      : Array.from(new Set(all.map(x => x.question)));
    const rows2 = [new TableRow({
      tableHeader: true,
      children: [
        cell('测试问题', { bold: true, shade: 'EAF1FB', width: 40 }),
        ...sorted.slice().reverse().map(r => cell('第' + r.index + '轮耗时', { bold: true, shade: 'EAF1FB', width: Math.round(50 / sorted.length), align: AlignmentType.CENTER })),
      ],
    })];
    qs.forEach(q => {
      const cells = sorted.slice().reverse().map(r => {
        const hit = (r.results || []).find(x => x.question === q);
        if (!hit) return cell('—', { align: AlignmentType.CENTER });
        return cell(hit.elapsedSec == null ? (hit.card ? '卡片' : '—') : hit.elapsedSec + 's', { align: AlignmentType.CENTER });
      });
      rows2.push(new TableRow({ children: [cell(q), ...cells] }));
    });
    c.push(table(rows2));
    c.push(P(''));
    c.push(P('说明：该表用于观察同一问题在不同轮次间的响应耗时波动，可据此判断回答稳定性和服务性能的一致性。', { size: 19, color: '777777' }));
  }

  // 最新一轮完整问答
  const latest = sorted[0];
  if (latest) {
    c.push(new PageBreak());
    c.push(H('五、最新一轮（第 ' + latest.index + ' 轮）完整问答'));
    c.push(sourceTable(latest.results));
    c.push(P('来源标识：问答库为蓝色，单位知识库为绿色，其他为红色。', { size: 19, color: '777777' }));
    (latest.results || []).forEach((x, i) => {
      if (i > 0) c.push(new PageBreak());
      questionBlock(x, {
        shotFile: path.join(shotsDirOf(latest.id), `q${String(x.index).padStart(2, '0')}.png`),
        picWidth: 560,
        withFlow: false,
      }).forEach(p => c.push(p));
    });
  }

  return await Packer.toBuffer(new Document({
    styles: { default: { document: { run: { font: FONT, size: 21 } } } },
    sections: [{ properties: {}, children: c }],
  }));
}

module.exports = { buildRunReport, buildProjectReport };
