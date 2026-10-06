const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config.js');
const { buildRestoreContext } = require('./restore.js');
const { saveRunResult } = require('./saveRunResult.js');

// 全部可变配置集中在 config.js（环境变量 > config.local.json > 默认值）
const PORT = config.port;
const gwUrl = new URL(config.gatewayBase);
const GW_HOST = gwUrl.hostname;
const GW_PORT = gwUrl.port || (gwUrl.protocol === 'https:' ? '443' : '80');
const MAX_TOKENS = config.maxTokens;
const MAX_CTX_FILES = config.maxCtxFiles;      // 记忆目录最多读入 .md 文件数
const MAX_FILE_CHARS = config.maxFileChars;    // 单个记忆文件截断上限（字符）
const MAX_CTX_CHARS = config.maxCtxChars;      // 注入上下文总字符上限
const UPSTREAM_MAX = config.upstreamMax;       // 上游产出带入下一步的精简长度（字符）
const MAX_RULE_CHARS = config.maxRuleChars;    // 规则文件截断上限（字符）
const DEFAULT_RULE = config.rulePath;          // 规则锚点（可选）
const DEFAULT_MEMORY = config.memoryDirs;      // 记忆库目录（每个含 MEMORY.md 索引）
const DEFAULT_DOC_DIRS = config.docDirs;       // 项目历史目录（可选）

function gwRequest(method, urlPath, payloadObj) {
  return new Promise((resolve, reject) => {
    const payload = payloadObj ? JSON.stringify(payloadObj) : null;
    const headers = {};
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const req = http.request({ host: GW_HOST, port: GW_PORT, path: urlPath, method, headers }, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', e => reject(e));
    req.setTimeout(180000, () => { req.destroy(); reject(new Error('gateway timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// 打一次网关：messages 是完整消息数组（可含 system / user）
async function chat(model, messages) {
  try {
    const r = await gwRequest('POST', '/v1/chat/completions', {
      model, messages, max_tokens: MAX_TOKENS, stream: false,
    });
    if (r.status !== 200) return { ok: false, error: 'gateway ' + r.status + ': ' + r.body.slice(0, 300) };
    try {
      const j = JSON.parse(r.body);
      const content = (j.choices && j.choices[0] && j.choices[0].message) ? j.choices[0].message.content : '';
      return { ok: true, text: content, model: j.model || model };
    } catch (e) { return { ok: false, error: 'parse fail: ' + e.message, raw: r.body.slice(0, 400) }; }
  } catch (e) {
    return { ok: false, error: 'gateway unreachable: ' + e.message + '（确认上游网关 ' + config.gatewayBase + ' 可访问）' };
  }
}

async function listModels() {
  try {
    const r = await gwRequest('GET', '/v1/models');
    if (r.status !== 200) return [];
    const j = JSON.parse(r.body);
    return (j.models || []).map(m => ({ id: m.slug, name: m.slug }));
  } catch (e) { return []; }
}

// 读一个记忆目录下的 .md 文件。
// 返回 { ok:true, dir, entries:[{name,text}], totalChars } 或 { ok:false, error }
function readContext(dir) {
  if (!dir) return { ok: false, error: 'dir required' };
  if (!path.isAbsolute(dir)) dir = path.resolve(dir);
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.md')); }
  catch (e) { return { ok: false, error: '无法打开目录: ' + dir + '（' + e.message + '）' }; }
  if (!files.length) return { ok: false, error: '该目录下没有 .md 文件: ' + dir };
  files.sort();
  const entries = [];
  let total = 0;
  for (const f of files.slice(0, MAX_CTX_FILES)) {
    if (total >= MAX_CTX_CHARS) break;
    let text;
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); }
    catch (e) { continue; }
    if (text.length > MAX_FILE_CHARS) text = text.slice(0, MAX_FILE_CHARS) + '\n…[已截断]';
    total += text.length;
    entries.push({ name: f, text });
  }
  return { ok: true, dir, entries, totalChars: total };
}

// 拼成可注入的系统上下文文本
function fmtContext(ctx) {
  if (!ctx || !ctx.ok || !ctx.entries.length) return '';
  const files = ctx.entries.map(e => `### 文件：${e.name}\n${e.text}`).join('\n\n');
  return `【项目记忆（来自 ${ctx.dir}，共 ${ctx.entries.length} 个 md 文件）】\n${files}`;
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body) || {}); } catch (_) { resolve({}); } });
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// 读单个规则文件（允许指定路径；超限截断）
function readRuleText(rulePath) {
  try {
    if (!rulePath) return '';
    if (!path.isAbsolute(rulePath)) rulePath = path.resolve(rulePath);
    let text = fs.readFileSync(rulePath, 'utf8');
    if (text.length > MAX_RULE_CHARS) text = text.slice(0, MAX_RULE_CHARS) + '\n…[已截断]';
    return text;
  } catch (e) { return ''; }
}

// 恢复并理解：让低价模型先把"规则 + 记忆索引 + 项目历史"压缩成一份可执行的背景摘要。
// 后续角色不再分别烧全文 token，只注入这份摘要。
async function summarizeRules(rulePath, model, restoreCtx) {
  const full = readRuleText(rulePath);
  const mem = restoreCtx ? restoreCtx.contextText : '';
  if (!full && !mem) return { ok: false, error: '规则文件不存在或不可读: ' + rulePath };
  let userContent = '';
  if (full) userContent += '### 我们的规则原文\n' + full + '\n\n';
  if (mem) userContent += '### 我们项目记忆/项目历史背景\n' + mem;
  const r = await chat(model || config.modelFast, [
    { role: 'system', content: '你是「恢复上下文」整理器。用户会把规则和项目记忆原文给你。你的任务：把它压缩成一份可执行的背景摘要，包含(a)必须遵守的硬规则/判定条件，(b)项目背景要点，(c)已知边界/未决事项。保留关键事实，不要臆造、不要解释过度、不要重写规则。' },
    { role: 'user', content: userContent },
  ]);
  return r;
}

// 产出有效性：空文本或工具调用标记 → 无效
function isValidOutput(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { ok: false, reason: '空内容' };
  if (/<(?:tool_calls|invoke|tool_call|function_calls)[\s>]|<\||<invoke[^>]*name=/.test(trimmed)) {
    return { ok: false, reason: '残缺工具调用标记（无有效正文）' };
  }
  return { ok: true, reason: '' };
}

// 串联流水线逐步执行：从 begin 步跑到 goal 步（含）。
// 每步 system = 规则摘要 + 记忆上下文 + 角色说明 + 上游产出（可选反馈）。
// 返回 { step, result, done, invalid }：run 到 goal 停（或 run 完所有步）。
async function runChainSteps(task, ctxText, steps, ruleSummary, upstream, begin, goal, redoFeedback) {
  if (begin < 0) begin = 0;
  if (goal < 0 || goal >= steps.length) goal = steps.length - 1;
  const from = Math.max(0, begin);
  for (let i = from; i <= goal && i < steps.length; i++) {
    const s = steps[i];
    let sys = '';
    if (ruleSummary) sys += '【已恢复并理解的规则要点（必须遵守）】\n' + ruleSummary + '\n\n';
    if (ctxText) sys += ctxText + '\n\n';
    sys += `你是角色「${s.name}」。${s.desc || ''}`;
    sys += '\n\n硬性要求：输出必须是真实工作产出，不得包含工具调用标记（如 <tool_calls>、<invoke>、<function_calls>）；不允许输出思考过程/空话。最后必须以一行「## 结论」明确给出本环节结论。';
    if (upstream.length) {
      const log = upstream.map(u => `## ${u.name} 产出\n${u.text}`).join('\n\n');
      sys += '\n\n### 已完成的上游环节产出（供你参考，不要复述，直接干你的活）\n' + log;
    }
    // 反馈重做：把用户对上一版产出的意见追加进 user 消息
    let userMsg = task;
    const redone = i === begin && redoFeedback;
    if (redone && String(redoFeedback || '').trim()) userMsg += '\n\n### 用户反馈（针对你上一版产出，请据此重做）\n' + redoFeedback;
    const r = await chat(s.model || config.modelFast, [
      { role: 'system', content: sys },
      { role: 'user', content: userMsg },
    ]);
    const text = r.ok ? (r.text || '') : '';
    const validity = isValidOutput(text);
    const invalidOutput = !r.ok || !validity.ok;
    const result = {
      key: s.key, name: s.name, model: s.model,
      ok: r.ok && validity.ok,
      text, error: r.ok ? ('产出无效：' + validity.reason + '，按规则中止流水线') : r.error,
      stopped: invalidOutput,
      redone: !!redone,
    };
    return { step: i, result, done: invalidOutput ? true : (i === steps.length - 1), invalid: invalidOutput };
  }
  return { step: goal < from ? goal : Math.min(goal, steps.length - 1), result: null, done: true, invalid: false };
}

// 规则摘要缓存：同一 rulePath + 恢复上下文字符数 只 summarize 一次，后续步骤复用
let ruleSummaryCache = { key: '', text: '' };
async function ensureRuleSummary(rulePath, ruleModel, restoreCtx) {
  const key = String(rulePath || DEFAULT_RULE) + '#' + (restoreCtx ? restoreCtx.totalChars : 0);
  if (ruleSummaryCache.key === key && ruleSummaryCache.text) return ruleSummaryCache.text;
  const rs = await summarizeRules(rulePath || DEFAULT_RULE, ruleModel || config.modelFast, restoreCtx);
  const text = rs.ok ? rs.text : '';
  ruleSummaryCache = { key, text };
  return text;
}

const server = http.createServer(async (req, res) => {
  // 单环节运行（可带记忆目录与规则文件；单独运行时也做一次规则摘要）
  if (req.method === 'POST' && req.url === '/api/run') {
    const body = await readJsonBody(req);
    const { role, name, model, task, dir, rulePath } = body;
    if (!task) return sendJson(res, 400, { ok: false, error: 'task required' });
    const ctxText = fmtContext(dir ? readContext(dir) : null);
    let ruleSummary = '';
    if (rulePath) {
      const rs = await summarizeRules(rulePath, model || config.modelFast);
      if (rs.ok) ruleSummary = rs.text;
    }
    let sys = '';
    if (ruleSummary) sys += '【已恢复并理解的规则要点（必须遵守）】\n' + ruleSummary + '\n\n';
    if (ctxText) sys += ctxText + '\n\n';
    if (name || role) sys += `你是角色「${name || role}」。`;
    const messages = sys ? [{ role: 'system', content: sys }, { role: 'user', content: task }] : [{ role: 'user', content: task }];
    return sendJson(res, 200, await chat(model || config.modelFast, messages));
  }

  // 串联流水线：逐步执行。前端每步调一次：
  // begin=当前步(0-based)，goal=要跑到哪步(含即止)；上游结果由浏览器维护在 upstream 传入。
  // done=true 时（跑到最后一步 或 某步无效）才自动写双文件。
  if (req.method === 'POST' && req.url === '/api/chain') {
    const body = await readJsonBody(req);
    const { task, dir, steps, rulePath, ruleModel, useRestore, begin, goal, upstream, redoFeedback } = body;
    if (!task) return sendJson(res, 400, { ok: false, error: 'task required' });
    const stepList = (Array.isArray(steps) && steps.length) ? steps : [];
    if (!stepList.length) return sendJson(res, 400, { ok: false, error: 'steps required' });

    // 恢复上下文：规则 + 记忆库 + 项目历史目录（记忆目录可不填）
    let ctxText = '';
    let restoreCtx = null;
    let contextFiles = 0;
    if (useRestore) {
      const docDirs = dir ? [dir, ...DEFAULT_DOC_DIRS] : []; // dir 为空就不注入项目历史，只注入规则+记忆库
      restoreCtx = buildRestoreContext({ rulePath: rulePath || DEFAULT_RULE, memoryDirs: DEFAULT_MEMORY, docDirs });
      ctxText = restoreCtx.contextText;
      contextFiles = (restoreCtx.contextText.match(/### /g) || []).length;
    } else {
      const ctx = dir ? readContext(dir) : null;
      ctxText = fmtContext(ctx);
      contextFiles = ctx && ctx.ok ? ctx.entries.length : 0;
    }

    // 恢复理解环节：每步都重新做规则摘要太贵；用全局缓存（按 rulePath+restoreCtx 字符摘要）
    const ruleSummary = await ensureRuleSummary(rulePath, ruleModel, restoreCtx);

    const b = Number.isInteger(begin) ? begin : 0;
    const g = Number.isInteger(goal) ? goal : (stepList.length - 1);
    const up = Array.isArray(upstream) ? upstream : [];
    const chain = await runChainSteps(task, ctxText, stepList, ruleSummary, up, b, g, redoFeedback);

    const results = chain.result ? [{
      key: chain.result.key, name: chain.result.name, model: chain.result.model,
      ok: chain.result.ok, text: chain.result.text, error: chain.result.error,
      stopped: chain.result.stopped, redone: chain.result.redone,
    }] : [];
    const saved = chain.done ? saveRunResult({
      task, dir: dir || null, rulePath: rulePath || null,
      useRestore: !!useRestore, restoreCtx: restoreCtx ? {
        rulesLoaded: restoreCtx.rulesLoaded,
        memoryCount: (restoreCtx.contextText.match(/【记忆库/g) || []).length,
        docCount: (restoreCtx.contextText.match(/【项目历史目录/g) || []).length,
        totalChars: restoreCtx.totalChars,
        truncated: restoreCtx.truncated,
      } : null,
      results: [...up, ...results],
      stopped: chain.done && chain.invalid,
    }) : null;

    return sendJson(res, 200, {
      ok: true,
      dir: dir || null,
      contextFiles,
      rulesLoaded: ruleSummary ? true : false,
      restoreMode: useRestore ? true : false,
      step: chain.step,
      done: chain.done,
      invalid: chain.invalid,
      result: chain.result,
      saved,
    });
  }

  // 记忆目录预览（诊断用：确认目录里有什么）
  if (req.method === 'POST' && req.url === '/api/context') {
    const body = await readJsonBody(req);
    const ctx = readContext(body.dir);
    if (!ctx.ok) return sendJson(res, 200, { ok: false, error: ctx.error });
    return sendJson(res, 200, {
      ok: true, dir: ctx.dir,
      files: ctx.entries.map(e => ({ name: e.name, chars: e.text.length })),
      totalChars: ctx.totalChars,
    });
  }

  // 恢复上下文预览（不耗 token）：返回将注入各角色的规则+记忆+项目历史概要
  // dir 可不填；不填则只看规则 + 记忆库，不注入项目历史
  if (req.method === 'POST' && req.url === '/api/restore') {
    const body = await readJsonBody(req);
    const rulePath = body.rulePath || DEFAULT_RULE;
    const docDirs = body.dir ? [body.dir, ...DEFAULT_DOC_DIRS] : [];
    const rc = buildRestoreContext({ rulePath, memoryDirs: DEFAULT_MEMORY, docDirs });
    return sendJson(res, 200, {
      ok: true,
      rulesLoaded: rc.rulesLoaded,
      memoryCount: (rc.contextText.match(/【记忆库/g) || []).length,
      docCount: (rc.contextText.match(/【项目历史目录/g) || []).length,
      totalChars: rc.totalChars,
      truncated: rc.truncated,
    });
  }

  // 可选历史目录列表（弹出框选择用）：列出记录目录下按日期命名的目录
  if (req.method === 'GET' && req.url === '/api/dirs') {
    const base = config.recordDir;
    let names = [];
    try {
      const all = fs.readdirSync(base, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .filter(n => /^\d{4}-\d{2}-\d{2}/.test(n))
        .sort()
        .reverse();
      names = all;
    } catch (e) { /* 记录目录不存在则返回空 */ }
    return sendJson(res, 200, { ok: true, base, dirs: names });
  }

  if (req.method === 'GET' && req.url === '/api/config') {
    return sendJson(res, 200, {
      ok: true,
      rulePath: config.rulePath,
      recordDir: config.recordDir,
      modelFast: config.modelFast,
      modelStrong: config.modelStrong,
      gatewayBase: config.gatewayBase,
    });
  }
  if (req.method === 'GET' && req.url === '/api/models') {
    const models = await listModels();
    const fallback = [
      { id: config.modelFast, name: config.modelFast + '（快/省）' },
      { id: config.modelStrong, name: config.modelStrong + '（强）' },
    ];
    return sendJson(res, 200, { ok: true, models: models.length ? models : fallback });
  }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) { return sendJson(res, 500, { ok: false, error: 'index.html missing' }); }
    return;
  }
  if (req.method === 'GET' && req.url === '/api/health') {
    const models = await listModels();
    return sendJson(res, 200, { ok: true, service: 'openclaw-pipeline', gateway: config.gatewayBase, modelsAvailable: models.length });
  }
  return sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => console.log('openclaw-pipeline listening on http://127.0.0.1:' + PORT + ' (gateway ' + config.gatewayBase + ')'));