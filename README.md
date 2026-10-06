# openclaw-pipeline

> 角色化 LLM 流水线：把「需求评审 → 开发实现 → 测试验证 → 提交 → 考试验收」串成一条可逐步确认的流水线。
>
> A role-based LLM pipeline: requirement review → development → testing → commit → acceptance, with step-by-step human confirmation.

零依赖（只用 Node 内置模块），直连任意 OpenAI 兼容网关。

## 特性

- **五角色串联**：每一环的产出自动带入下一环，形成上下文链条。
- **逐步确认**：每个环节完成即可查看产出，选择「继续下一步 / 反馈重做 / 停止」。
- **上下文恢复**：可从「规则文件 + 记忆库目录 + 项目历史目录」组装恢复上下文，先用低价模型压缩成摘要再注入各角色，避免重复烧全文 token。
- **产出校验**：空产出、或残留工具调用标记的产出，会被判定为无效并立即中止流水线。
- **自动留档**：每次运行在记录目录下新建独立目录，写 `learning-notes.md`（给人看）与 `full-conversation.md`（给 AI 看）双文件。
- **模型可换**：每个角色可在界面下拉里单独选模型。

## 快速开始

要求 Node.js ≥ 18。

1. 启动一个 OpenAI 兼容网关（本地推理服务、代理、或任意云厂商兼容端点均可）。
2. 告诉本服务网关地址，然后启动：

```bash
GATEWAY_BASE=http://127.0.0.1:8080 npm start
# Windows PowerShell: $env:GATEWAY_BASE="http://127.0.0.1:8080"; npm start
```

3. 浏览器打开 <http://127.0.0.1:8787>。

## 配置

优先级：**环境变量 > `config.local.json` > 内置默认值**。

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PIPELINE_PORT` | `8787` | 本服务监听端口 |
| `GATEWAY_BASE` | `http://127.0.0.1:8080` | 上游 OpenAI 兼容网关根地址（不含 `/v1`） |
| `MODEL_FAST` | `gpt-4o-mini` | 「便宜」档默认模型（占位名，请改成你网关里实际存在的 id） |
| `MODEL_STRONG` | `gpt-4o` | 「强」档默认模型（同上） |
| `RULE_PATH` | 空 | 规则文件路径（可选） |
| `MEMORY_DIRS` | 空 | 记忆库目录列表，分号分隔；每个目录含 `MEMORY.md` 索引（可选） |
| `DOC_DIRS` | 空 | 项目历史目录列表，分号分隔（可选） |
| `RECORD_DIR` | `./runs` | 运行记录输出目录 |

也可以把上述键写进 `config.local.json`（见 `config.local.json.example`）。该文件已在 `.gitignore` 中，不会被提交。

## 各角色

| 环节 | 职责 | 默认档 |
|---|---|---|
| ① 需求评审 | 审需求/边界/风险 | 强 |
| ② 开发实现 | 按评审写代码 | 便宜 |
| ③ 测试验证 | 生成用例/自测要点 | 便宜 |
| ④ 提交 | 整理改动、写提交信息 | 便宜 |
| ⑤ 考试验收 | 按标准严格验收 | 强 |

## 目录结构

```
server.js          HTTP 服务 + 流水线编排 + 产出校验
config.js          集中配置（环境变量 / config.local.json）
restore.js         恢复上下文组装（规则 + 记忆库 + 项目历史）
saveRunResult.js   双文件自动留档
index.html         前端界面
```

## 记忆库格式

`MEMORY_DIRS` 里每个目录用一个 `MEMORY.md` 作索引，条目形如：

```markdown
- [标题](文件名.md) — 一句话描述
```

服务只读取索引里命中的 `.md` 文件，避免整目录全量注入。

## 隐私说明

- 本仓库不含任何个人路径、账号或私有数据；所有本地化配置都通过环境变量或 `config.local.json` 注入。
- `config.local.json`、`runs/`、`server.log` 均在 `.gitignore` 中，不会被提交。
- 提交前请自行确认 `git config user.email` 不会暴露你不愿公开的邮箱。

## License

MIT
