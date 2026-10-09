# Pi Harness 接入（复用本机已安装的 Pi 作为外部 agent runtime）

> 状态：设计提案（未实现）。「Pi harness」在此指：把本机已安装的 [Pi](https://github.com/earendil-works/pi-coding-agent)（`@earendil-works/pi-coding-agent`，本机 0.86.0 / latest 1.1.0）作为 ZCode 可驱动的外部 agent runtime 接入，而非在 ZCode 里重写一套 harness。与 `harness-token-efficiency.md`（把 SoL-Pi 机制内化进 ZCode 自身 harness）互补：那篇是「ZCode 变省」，本篇是「ZCode 能驱动 Pi（含 SoL-Pi 扩展）」。

## 1. 目标与范围

- 让用户在 ZCode（Desktop / Web / CLI）中把某个会话或子任务交给本机 `pi` 执行：复用 Pi 自带的 provider/鉴权/工具/扩展（含已 `pi install` 的 SoL-Pi）。
- **依赖安装机器已装 Pi**：不把 Pi 打进 ZCode 依赖/分发包，运行时探测 `pi`（PATH、常见安装位），缺失则功能降级为不可用并明确提示（不自动联网安装）。
- 不在 ZCode 内实现 Pi 的 agent 循环、工具或扩展运行时（Pi 的 README 明确「Pi skips features like sub-agents and plan mode」，其价值正在于其自身生态）。

非目标：替换 ZCode 主 agent 循环；把 Pi 库作为 npm 依赖静态打进 CLI 二进制（跨平台二进制分发与版本锁定问题，见 §6 风险）。

## 2. Pi 对外接口事实（驱动方式三选）

| 方式 | 形态 | 类型安全 | 进程隔离 | 鉴权/凭证 | 对 ZCode 的影响 |
| --- | --- | --- | --- | --- | --- |
| **A. `pi --mode rpc`** 子进程 | stdin/stdout JSONL 帧（LF 分界；请求带 `id` 关联响应，事件流式） | 手写 schema | 是（推荐） | 复用本机 `~/.pi/agent/auth.json` 与环境变量，ZCode 不经手 | 只新增一个 spawn + 协议适配层 |
| B. `./client` 库（`rpc-client.ts`） | 进程内 Node 客户端，内部仍 spawn `pi --mode rpc` | TS 类型 | 是 | 同上 | 需要把 Pi 作为运行时可选依赖解析 |
| C. SDK（`createAgentSession` / `AgentSessionRuntime`） | 进程内直接构建 Pi 会话 | TS 类型 | 否 | 同上 | 耦合最深，Pi 升级直接冲击 ZCode 进程 |

结论：**首选 A（RPC 子进程）**。理由：进程隔离（Pi 崩溃/升级不波及 ZCode）、零打包耦合、语言无关、与 ZCode 既有的「desktop spawn zcode-cli over stdio NDJSON」模式同构。B 只是 A 的类型化封装、仍需把 Pi 解析为本机模块，收益不抵耦合；C 仅在未来要做深度共享 UI 时考虑。

### Pi RPC 协议要点（docs/rpc.md，0.86/1.1 均适用）

- 帧：严格 JSONL，`\n` 唯一分界；Node `readline` 不合规（会把 `U+2028/2029` 当换行），需自实现 decoder（Pi 文档给了参考实现）。
- 请求/响应：`{"id": "...", "type": "prompt" | "steer" | "follow_up" | "abort" | "get_state" | "get_messages" | "set_model" | "compact" | "bash" | ...}` → `{"id": "...", "type": "response", "command": "...", "success": bool, "data": ...}`。
- 流式事件：`agent_start/agent_end/agent_settled`、`turn_start/turn_end`、`message_start/message_update/message_end`（delta 粒度 text/thinking/toolcall）、`tool_execution_start/update/end`、`compaction_*`、`auto_retry_*` 等。
- 会话管理：`new_session`、`switch_session`、`fork`、`clone`、`get_entries`（append-only 树，稳定 entryId 可作游标）、`get_tree`、`--session-id/--session-dir/--no-session/--continue/--resume`。
- 权限/UI：extension UI 经 `extension_ui_request`/`extension_ui_response` 子协议（select/confirm/input/editor + 通知类）。Pi 的 bash 工具在 RPC 模式下**不弹权限框**（无交互 TUI），危险命令审批需由 ZCode 侧在转发前裁决或依赖 Pi 项目信任配置。
- 鉴权：`pi auth print-api-key --provider X` 可为外部客户端取 key；运行期用本机已登录凭证，ZCode 不接触。

## 3. 系统上下文：ZCode 现有 seam

- Desktop 驱动 agent 的唯一官方注入缝：`ZCODE_AGENT_SERVER_COMMAND` + `ZCODE_AGENT_SERVER_ARGS_JSON` 环境变量（`packages/services/src/zcode-agent/zcodeAgentProcessManager.ts:441`，解析链最高优先级），spawn 后以 ZCode Protocol（JSON-RPC over stdio NDJSON，`packages/shared/src/zcode-protocol`）对话。
- 进程内窄 port：`contracts/src/interfaces/subagent.port.ts:113` `SubagentPort`（launch/run/start/waitForTask/stopTask/sendMessage，入参 prompt+workingDirectory，返回 `AgentOutput`）——默认实现是进程内 child `AgentRuntime`，但完全可以换成「spawn 外部 CLI」的适配器。
- `AgentRuntime` 是具体类（660+ 方法安装）而非窄接口，主循环层面「换内核」不可行也不必要。
- 外部 I/O 原则：子进程统一走执行入口（spawn 参数数组、跨平台、超时/取消/审计），MCP 已有 `ProcessTreeStdioClientTransport` 可复用进程树回收/Windows Job Object 语义。

## 4. 方案（两档，建议先做低档验证价值）

### 4.1 档位一：Pi 作为子代理后端（`PiSubagentAdapter` 实现 `SubagentPort`）

把 Pi 挂到现有 `Agent`/`Task` 工具之后，作为与内置子代理并列的一种「外部子代理」后端。用户/主 agent 通过既有子代理入口选择 Pi 执行探索/实现类子任务。

**产品规则**

- 新增子代理后端类型 `pi`（与内置并列），选择来源：显式指定（工具入参/配置）或按任务类型路由；默认仍为内置子代理。
- 一次子代理运行 = spawn 一个 `pi --mode rpc` 进程，`--session-dir` 指向 ZCode 会话级子目录（便于审计与复用 `get_entries` 增量回放），`--no-session` 用于一次性无状态任务。
- prompt 由 ZCode 主 agent 产出；Pi 的工具与权限在 Pi 侧按本机配置执行（ZCode 不接管、不转发 Pi 的 shell 审批）。
- 结果回收：以 `agent_settled` 为一轮完成的边界（非 `agent_end`，后者可能跟着 retry/compaction）；用 `get_last_assistant_text` / `get_messages` / `get_entries(since=...)` 提取结果与增量。
- 取消/超时：映射到 `abort` + `clear_queue`；进程回收走统一执行入口（进程树、Windows Job Object）。
- 证据与观测：Pi 的 JSONL 事件流原样落 ZCode 会话 debug（traceId 贯穿），token/cost 从 `get_session_stats` 回填到 usage 观测。

**状态所有者与事件顺序**

```text
ZCode 主 agent（编排者，唯一入口：Agent/Task 工具）
  └─ SubagentPort（窄接口，唯一所有者：core/subagent）
        └─ PiSubagentAdapter（新模块，spawn + JSONL 帧 + 事件转译）
              └─ pi --mode rpc 子进程（agent 循环、工具、扩展、鉴权全在 Pi 内）
```

- 关键边界：ZCode 只拥有「何时派任务、何时收结果、何时取消」；Pi 拥有「怎么干活」。两侧不共享上下文窗口（Pi 有自己的 session/compact），ZCode 侧只消费 Pi 的终态文本 + 按需回放的增量条目。

**接口（新增模块 `apps/zcode-cli/packages/adapters/src/pi/`）**

- `detectPi(): Promise<{ available: boolean; version?: string; path?: string }>` — 探测 PATH 与常见安装位；不联网、不自动安装。
- `PiSubagentAdapter implements SubagentPort` — 入参 `{ prompt, workingDirectory, sessionId?, agentId? }`，内部维护 pid ↔ run 的映射、JSONL 帧编码/解码（自实现 decoder，不用 readline）、事件→`AgentOutput` 的转译。
- 配置：`features.piSubagent`（默认 false）+ `pi.path`（可选显式路径）+ `pi.defaultArgs`（可选追加启动参数白名单，如 `--provider/--model/--no-session`）。

### 4.2 档位二：Pi 作为整会话外部 runtime（`PiProtocolShim`，Desktop env 注入）

复用 desktop 的官方注入缝，写一个「ZCode Protocol ↔ Pi RPC」shim：desktop 把 `ZCODE_AGENT_SERVER_COMMAND` 指向 shim，即可让整个 ZCode UI（会话、事件、TUI 渲染、远程链路）驱动 Pi。

**产品规则**

- shim 以独立子进程形式存在（Node 脚本），实现 ZCode Protocol 子集：`runtime/capabilities`、`session/create`（映射 `pi --session-id`）、`session/resume`（映射 `--continue`/`get_entries` 回放）、v4 `sendText`（映射 `prompt`/`steer`/`follow_up`）、`session/subscribe`（Pi 事件 → ZCode SessionEvent 通知）、`session/stop`（`abort`）、`session/compact`（`compact`）、`session/debug`（`get_session_stats`）。未实现方法返回 `Method not found`（协议允许优雅降级）。
- 能力上报须如实：`runtime/capabilities` 标出与内置 runtime 的差异（如 Pi 无独立 plan 状态机、无 ZCode 的 workflow/dynamic-workflow 事件族）。
- 会话语义映射：Pi 的 append-only entry 树 ↔ ZCode 的 session；entryId 作为跨重启续传游标。
- 权限：Pi 侧无 ZCode 式权限框，shim 需把 Pi 的 extension UI（confirm/select）映射为 ZCode 的交互请求/响应接口，否则在 headless/远程场景下危险操作无裁决点。

**这一档工作量大**（协议面约 60 方法、v4 wire 版本 3、事件族映射、远程双链路验证），建议在档位一跑通且确有「整个 UI 都要用 Pi」的需求后再立项。

## 5. 推荐路径

1. **先做档位一（PiSubagentAdapter）**：侵入最小、价值可独立验证（主 agent 仍是 ZCode，Pi 只是可选后端），且天然兼容「Pi 装了 SoL-Pi 后子任务更省 token」的卖点。
2. 档位一稳定后再评估档位二；若目标只是「能用 Pi 干活」，档位一可能已足够，档位二未必需要。

## 6. 风险与边界

- **版本漂移**：`pi --mode rpc` 协议与 SDK 在 0.86 → 1.1 之间有演进（如 `agent_settled`、v4 相关语义），适配层需做能力探测与版本下限声明（建议 ≥ 0.86，对齐 SoL-Pi 的 0.85.1 兼容基线），失败降级为「Pi 不可用」而非报错崩溃。
- **凭证边界**：Pi 的 auth 全在本机 `~/.pi/agent/auth.json`，ZCode 不读取、不复制、不转发；远程 workspace（SSH/手机远控）场景下，Pi 运行在「安装它的那台机器」本地，凭证不出该机。
- **权限与危险操作**：Pi RPC 模式无 ZCode 的逐命令审批；档位一通过「只派明确子任务 + 子代理作用域」控制爆炸半径，档位二必须补权限映射，否则不符合 ZCode 的权限收口原则。
- **跨平台**：spawn 走统一执行入口；Windows 下 `pi` 可能为 `pi.cmd`/npm shim，探测需考虑 PATHEXT 与空格路径。
- **打包**：不把 Pi 打进 ZCode 安装包；探测不到时 UI/工具层明确提示「安装 Pi 后可用」，给出官方安装指引链接。

## 7. 验收场景（档位一）

1. 未安装 Pi 的机器：`features.piSubagent` 开启时功能优雅降级，提示安装，不影响内置子代理。
2. 已装 Pi：主 agent 通过子代理入口把「探索某目录结构」派给 Pi；Pi 完成后 ZCode 收到终态文本，事件流与 token 用量可在 ZCode 会话 debug 中观测。
3. 子任务运行中用户取消：Pi 进程收到 `abort` 并被回收，无僵尸进程。
4. Pi 进程异常退出/协议返回解析失败：ZCode 侧子代理标记失败并给出可读错误，不拖垮主会话。
5. 配置了 SoL-Pi 的 Pi：子任务的观测/日志在 Pi 侧按 SoL-Pi 语义被压缩，ZCode 只消费其结果（不需要也不应该感知 SoL-Pi 的内部机制）。
