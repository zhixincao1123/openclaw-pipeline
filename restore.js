const fs = require('fs');
const path = require('path');

const MAX_FILE_CHARS = 60000;
const MAX_TOTAL_CHARS = 260000;
const MAX_MEMORY_FILES = 30;
const MAX_DOC_DIRS = 3;
const MAX_DOC_FILES = 12;

// 读文件，超限截断
function readFileLimited(p) {
  try {
    let t = fs.readFileSync(p, 'utf8');
    if (t.length > MAX_FILE_CHARS) t = t.slice(0, MAX_FILE_CHARS) + '\n…[已截断]';
    return t;
  } catch (_) { return ''; }
}

// 从记忆索引 MEMORY.md 提取"文件名 -> 描述"行
function parseIndex(mdText) {
  const rows = [];
  for (const line of String(mdText || '').split(/\r?\n/)) {
    const m = line.match(/\[([^\]]+)\]\(([^)]+\.md)\)\s*—\s*(.+)/);
    if (m) rows.push({ title: m[1], file: m[2], desc: m[3] });
  }
  return rows;
}

// 给定一个 memory 目录，返回 { indexText, entries }；entries 按索引命中优先
function readMemoryDir(dir) {
  const out = { indexText: '', entries: [] };
  if (!dir) return out;
  const indexPath = path.join(dir, 'MEMORY.md');
  const indexText = readFileLimited(indexPath);
  out.indexText = indexText;
  if (!indexText) return out;
  const rows = parseIndex(indexText).slice(0, MAX_MEMORY_FILES);
  for (const r of rows) {
    const p = path.join(dir, path.basename(r.file));
    const t = readFileLimited(p);
    if (t) out.entries.push({ name: r.file, title: r.title, text: t });
  }
  return out;
}

// 递归收集目录下 .md（一层就够），按目录名+文件名排序
function collectMd(dir) {
  const res = [];
  if (!dir) return res;
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return res; }
  for (const it of items.sort((a, b) => a.name.localeCompare(b.name))) {
    if (it.isFile() && it.name.toLowerCase().endsWith('.md')) res.push(path.join(dir, it.name));
    else if (it.isDirectory() && it.name.toLowerCase().startsWith('sdd')) {
      // 跳过 sdd 批次目录，避免噪音
    }
  }
  return res;
}

// 组装恢复上下文。rulePath/memoryDirs/docDirs 都是显式输入。
function buildRestoreContext({ rulePath, memoryDirs, docDirs }) {
  const parts = [];
  let rulesLoaded = false;

  if (rulePath) {
    const ruleText = readFileLimited(rulePath);
    if (ruleText) {
      parts.push(`【规则原文：${rulePath}】\n${ruleText}`);
      rulesLoaded = true;
    }
  }

  const memoryDirsList = Array.isArray(memoryDirs) ? memoryDirs.filter(Boolean) : [];
  if (memoryDirsList.length) {
    for (const dir of memoryDirsList) {
      const mem = readMemoryDir(dir);
      if (!mem.indexText && !mem.entries.length) continue;
      const rows = parseIndex(mem.indexText);
      const indexBlock = rows.length
        ? rows.map(r => `- ${r.title} — ${r.desc}`).join('\n')
        : '(无索引条目)';
      const entryBlocks = mem.entries.map(e => `### 记忆：${e.name}\n${e.text}`).join('\n\n');
      parts.push(`【记忆库：${dir}】\n索引：\n${indexBlock}\n\n${entryBlocks}`);
    }
  }

  const docDirsList = Array.isArray(docDirs) ? docDirs.filter(Boolean) : [];
  if (docDirsList.length) {
    const chosen = [];
    for (const dir of docDirsList.slice(0, MAX_DOC_DIRS)) {
      const files = collectMd(dir).slice(0, MAX_DOC_FILES);
      if (!files.length) continue;
      chosen.push({ dir, files });
    }
    for (const c of chosen) {
      const fileBlocks = c.files.map(p => {
        const base = path.basename(p);
        const text = readFileLimited(p);
        return `### ${c.dir}/${base}\n${text}`;
      }).join('\n\n');
      parts.push(`【项目历史目录：${c.dir}】\n${fileBlocks}`);
    }
  }

  const combined = parts.join('\n\n');
  const truncated = combined.length > MAX_TOTAL_CHARS;
  return {
    ok: true,
    rulesLoaded,
    contextText: truncated ? combined.slice(0, MAX_TOTAL_CHARS) + '\n…[恢复上下文已截断]' : combined,
    charCount: combined.length,
    totalChars: combined.length,
    truncated,
  };
}

module.exports = { buildRestoreContext, readFileLimited, parseIndex, readMemoryDir, collectMd };
