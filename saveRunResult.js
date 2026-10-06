const fs = require('fs');
const path = require('path');
const config = require('./config.js');

// 目录名：<记录目录>/<日期>-pipeline-<分支>-<功能>
// 本次项目：openclaw；功能 = 任务标题
function buildDirName(taskTitle, now) {
  const date = (now || new Date()).toISOString().slice(0, 10);
  const feat = sanitizeFeature(taskTitle);
  return `${date}-pipeline-openclaw-${feat}`;
}

// 功能标题：去掉路径非法字符，截断 30 字
function sanitizeFeature(t) {
  const clean = String(t || '').replace(/[\\/:*?"<>|\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
  return (clean || '未命名任务').slice(0, 30);
}

// 目标目录：直接落在记录目录下；同名冲突追加 -2/-3
function targetDir(taskTitle, now) {
  const base = config.recordDir;
  const name = buildDirName(taskTitle, now);
  let dir = path.join(base, name);
  let n = 2;
  while (fs.existsSync(dir)) {
    dir = path.join(base, `${name}-${n}`);
    n++;
  }
  return { name, dir };
}

function fmtMeta(prefix, obj) {
  const lines = [prefix];
  for (const [k, v] of Object.entries(obj || {})) lines.push(`**${k}**：${v}`);
  return lines.join('\n');
}

// learning-notes.md（用户看）
function buildLearningNotes({ task, restoreCtx, results, ts, dirName }) {
  const out = [];
  out.push(`# ${dirName} · learning-notes`);
  out.push('');
  out.push(`> 执行时间：${ts}`);
  out.push('> 自动记录：openclaw-pipeline 流水线运行结果');
  out.push('');
  out.push('## 任务');
  out.push('');
  out.push('```');
  out.push(task);
  out.push('```');
  out.push('');
  if (restoreCtx) {
    out.push('## 恢复上下文');
    out.push('');
    out.push(`- 规则：${restoreCtx.rulesLoaded ? '已读' : '未读'}`);
    out.push(`- 记忆库：${restoreCtx.memoryCount} 个`);
    out.push(`- 项目历史：${restoreCtx.docCount} 个目录`);
    out.push(`- 注入字符：${restoreCtx.totalChars}`);
    out.push('');
  }
  out.push('## 各环节产出');
  out.push('');
  for (const r of results) {
    out.push(`### ${r.name}（${r.model}）`);
    out.push('');
    if (r.ok) out.push(r.text);
    else out.push(`**失败**：${r.error || 'unknown'}`);
    out.push('');
  }
  return out.join('\n');
}

// full-conversation.md（给 AI）
function buildFullConversation({ task, dir, rulePath, restoreCtx, results, ts, dirName, useRestore, stopped }) {
  const out = [];
  out.push(`# ${dirName} · full-conversation`);
  out.push('');
  out.push(`> 执行时间：${ts}`);
  out.push('> 记录类型：流水线自动运行结果（每次任务新建目录，双文件）');
  out.push('');
  out.push('## 输入');
  out.push('');
  out.push('- 恢复模式：' + (useRestore ? '是' : '否'));
  out.push('- 记忆目录：' + (dir || '(未填，不注入项目历史)'));
  out.push('- 规则文件：' + (rulePath || '(默认)'));
  out.push('- 是否中止：' + (stopped ? '是（某环节失败/空产出，已停止后续）' : '否（全程跑完）'));
  out.push('');
  if (restoreCtx) {
    out.push('## 恢复上下文');
    out.push('');
    out.push('- 规则：' + (restoreCtx.rulesLoaded ? '已读' : '未读'));
    out.push('- 记忆库数：' + restoreCtx.memoryCount);
    out.push('- 项目历史目录数：' + restoreCtx.docCount);
    out.push('- 字符数：' + restoreCtx.totalChars);
    out.push('- 截断：' + (restoreCtx.truncated ? '是' : '否'));
    out.push('');
    out.push('```');
    out.push('（恢复上下文原文已按规则用于本次执行，默认不在此重复）');
    out.push('```');
    out.push('');
  }
  out.push('## 任务原文');
  out.push('');
  out.push('```');
  out.push(task);
  out.push('```');
  out.push('');
  out.push('## 各环节原始输出');
  out.push('');
  for (const r of results) {
    out.push(`### ${r.key}: ${r.name}`);
    out.push('');
    out.push('- ok: ' + r.ok);
    out.push('- model: ' + r.model);
    out.push('');
    if (r.ok) {
      out.push('```');
      out.push(r.text || '');
      out.push('```');
    } else {
      out.push(`错误：${r.error || 'unknown'}`);
    }
    out.push('');
  }
  return out.join('\n');
}

// 保存一次运行结果：<记录目录>/<日期>-pipeline-openclaw-<功能>/{learning-notes.md,full-conversation.md}
function saveRunResult(payload) {
  try {
    const now = new Date();
    const { name: dirName, dir } = targetDir(payload.task, now);
    fs.mkdirSync(dir, { recursive: true });
    const ts = now.toLocaleString('zh-CN', { hour12: false });
    const learning = buildLearningNotes({ ...payload, ts, dirName });
    const full = buildFullConversation({ ...payload, ts, dirName });
    fs.writeFileSync(path.join(dir, 'learning-notes.md'), learning, 'utf8');
    fs.writeFileSync(path.join(dir, 'full-conversation.md'), full, 'utf8');
    return {
      ok: true, dir, dirName,
      learningPath: path.join(dir, 'learning-notes.md'),
      fullPath: path.join(dir, 'full-conversation.md'),
    };
  } catch (e) {
    return { ok: false, error: '自动记录失败: ' + e.message };
  }
}

module.exports = { saveRunResult, buildDirName, sanitizeFeature, targetDir };