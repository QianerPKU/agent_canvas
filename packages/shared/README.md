# @agent-canvas/shared

前后端共享的**类型契约**。当前只含类型与少量纯函数（无运行时依赖），编译为 ESM 供 `apps/server` 与 `apps/web` 引用。

## 内容

### 统一事件模型 (`src/events.ts`)

把 Claude Agent SDK 的原始消息归一成与 SDK 解耦的语义事件，是整个系统的核心契约。

| 导出 | 说明 |
| --- | --- |
| `AgentStatus` | agent 运行状态机：`idle / starting / running / waiting_input / done / stopped / terminated / error` |
| `isTerminalStatus()` / `TERMINAL_STATUSES` | 判断/列举终态（`done/stopped/terminated/error`） |
| `AgentProvider` | 底层 agent 驱动：`claude / codex` |
| `CODEX_MODELS` / `DEFAULT_CODEX_MODEL` | Codex UI 可选模型与默认模型 |
| `CompactTrigger` | compact 来源：`manual` 表示用户触发并独立成轮，`auto` 表示 provider 自动压缩且保留在当前业务轮 |
| `UserInputMode` | 运行中输入模式：`queued` 表示排到下一轮，`steer` 表示引导当前 in-flight turn；未设置表示普通轮次输入 |
| `AgentEvent` | 归一化事件的可辨识联合（判别字段 `kind`）：`status / user_input / compact / system_init / thinking / assistant_text / tool_use / tool_result / result / error` |
| `AgentEventEnvelope` | 传输信封：`{ agentId, seq, at, event }`，带单调序号便于回放/补齐 |
| `AgentStartConfig` | 启动 agent 的配置（provider、prompt、cwd、model、权限模式、`zoneId` 占位等） |
| `ClientCommand` | 客户端→服务端命令：`start / stop / compact / terminate / send / steer / resume` |
| `AgentSnapshot` | agent 当前快照（REST 列表、重连补齐） |

## 设计约定

- **事件单向、命令单向**：后端→前端只发 `AgentEvent`（包在 `AgentEventEnvelope` 里）；前端→后端只发 `ClientCommand`。
- **seq 单调递增**：每个 agent 的事件带连续 `seq`，前端可据此判断丢包/排序，未来支持断线重连补齐。
- **与 provider 解耦**：前端不依赖 Claude SDK 或 Codex app-server 的任何原始类型；provider→统一事件的映射只发生在 `apps/server`。

## 开发

```bash
npm run build --workspace packages/shared   # tsc 编译到 dist/
npm test --workspace packages/shared        # vitest
```

## 文件节点模型

`src/files.ts` 定义 `CanvasFileNode`、`CanvasFileConnection`、创建/更新输入，以及服务端解析后的 `AgentFileAccess`。普通节点通过 `read/write` 连线授权，共享节点通过全局读写开关授权。

`CreateCanvasFileInput.directory` 允许 `storage="agent"` 时显式指定工作目录；前端新建文件默认使用画布工作目录，不再必须选择某个 Agent。

## Agent 设置模型

`src/events.ts` 定义 `AgentSettings`、`CreateAgentInput` 和 `UpdateAgentSettingsInput`。创建 Agent 可带 provider、模型、工作目录和私有系统提示词；更新已创建 Agent 时只允许调整私有系统提示词。`AgentStartConfig.systemPrompt` 只表示画布私有提示词，会按提示词节点方式拼接到业务输入中。

## 提示词节点模型

`src/prompts.ts` 定义纯文本 `CanvasPromptNode`、普通节点连线、共享读写开关，以及服务端解析后的 `AgentPromptAccess`。读权限把文本直接拼接进 Agent 上下文，写权限授权 Agent 修改节点的内部文本载体；可读提示词已由服务端按稳定顺序排列。
