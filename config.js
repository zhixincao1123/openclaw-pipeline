// config.js —— 集中配置。
// 优先级：环境变量 > config.local.json > 内置默认值。
// 把 config.local.json 排除在版本控制之外（见 .gitignore），
// 本地个性化配置（个人路径、私有网关等）就不会进仓库。
const fs = require('fs');
const path = require('path');

let local = {};
try {
  local = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.local.json'), 'utf8'));
} catch (_) { /* 无本地配置 → 用默认值 */ }

function pick(envKey, localKey, def) {
  if (process.env[envKey]) return process.env[envKey];
  if (local[localKey] !== undefined && local[localKey] !== '') return local[localKey];
  return def;
}
function pickInt(envKey, localKey, def) {
  const n = parseInt(pick(envKey, localKey, ''), 10);
  return Number.isFinite(n) ? n : def;
}
function pickList(envKey, localKey, def) {
  const v = pick(envKey, localKey, null);
  if (v == null) return def;
  if (Array.isArray(v)) return v;
  return String(v).split(/[;,]/).map(s => s.trim()).filter(Boolean);
}

module.exports = {
  // 本服务监听端口
  port: pickInt('PIPELINE_PORT', 'port', 8787),

  // 上游 OpenAI 兼容网关的根地址（不含 /v1）；任何兼容实现都可以
  gatewayBase: pick('GATEWAY_BASE', 'gatewayBase', 'http://127.0.0.1:8080'),

  // 角色默认模型（占位名，请改成你网关里实际存在的 model id）
  modelFast: pick('MODEL_FAST', 'modelFast', 'gpt-4o-mini'),
  modelStrong: pick('MODEL_STRONG', 'modelStrong', 'gpt-4o'),

  // 恢复上下文（都可留空）
  rulePath: pick('RULE_PATH', 'rulePath', ''),            // 规则文件路径
  memoryDirs: pickList('MEMORY_DIRS', 'memoryDirs', []),  // 记忆库目录（每个含 MEMORY.md 索引）
  docDirs: pickList('DOC_DIRS', 'docDirs', []),           // 项目历史目录

  // 运行记录（双文件）输出目录
  recordDir: pick('RECORD_DIR', 'recordDir', path.join(__dirname, 'runs')),

  // 各项额度
  maxTokens: pickInt('MAX_TOKENS', 'maxTokens', 6000),
  maxCtxFiles: pickInt('MAX_CTX_FILES', 'maxCtxFiles', 20),
  maxFileChars: pickInt('MAX_FILE_CHARS', 'maxFileChars', 60000),
  maxCtxChars: pickInt('MAX_CTX_CHARS', 'maxCtxChars', 200000),
  upstreamMax: pickInt('UPSTREAM_MAX', 'upstreamMax', 6000),
  maxRuleChars: pickInt('MAX_RULE_CHARS', 'maxRuleChars', 60000),
};
