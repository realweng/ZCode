# Session Token Throughput（tok/s 实时吞吐展示）

## 产品规则

- 主对话每个工作段的「工作中 N 分 N 秒」行，右缘对齐显示实时吞吐 `xx.x tok/s`。
- **两个数值来源，显示优先级**：
  1. **流式估算 `~xx.x tok/s`（带 `~` 前缀）**：流式输出（含思考）期间实时更新。基于 renderer 已收到的当前运行段 reasoning/assistantText 增量，按与 CLI `estimateTokens` 相同的公式（中文双权重 ÷ `ESTIMATED_TOKEN_CHAR_DIVISOR`）换算，滑动窗口约 4 秒取斜率；样本跨度 <800ms、增量非正或最新样本静默 >2s（工具执行/请求间隙）时不显示。
  2. **精确值 `xx.x tok/s`**：最近一次**已完成**模型请求的 `outputTokens / (durationMs - timeToFirstContentMs)`（`calculateOutputTps`，与开发者工具面板 TPS 列同源同口径）。估算静默回落时接管显示。
- 仅 `workStatus.state === "running"` 时显示；段完成后随「已工作 N」切换一并消失。
- 无事实时不渲染：两个来源都缺席时整段隐藏，绝不显示 `0 tok/s`。
- 状态面板 Agents 分区的子 agent 运行走目前只显示来源 2（子会话行级增量不进父会话 renderer）；子会话详情窗格内的「工作中」行与主对话同组件，两个来源都生效。

## 状态所有者与事件顺序

```text
精确值（协议事实）：
ModelNetworkStatus(model_request_completed, querySource=main_turn)
  → CLI agent 进程 session-debug 观测（唯一事实源，含 usage/durationMs/TTFT）
      ├─ 父会话：observeSessionDebug(record, event)          （既有，不变）
      └─ 子会话：observeDetachedChildSessionDebug(id, event)  （新增，server-operations 子会话分支）
  → UI useSessionDebug 1s 轮询 session/debug RPC（只读，不反向写）
  → useSessionThroughput 取 rounds.at(-1).tokensPerSecond

实时估算（展示层派生，非协议事实）：
reasoning/assistantText row.delta → 运行段 rows 的累计文本
  → useStreamingThroughput 滑动窗口斜率（~4s 窗口，样本 = 每次 delta 的估算 token 数）
  → 「工作中」行优先显示（~ 前缀）
```

- 精确值 owner = agent 进程的 session-debug 观测；实时估算 owner = 渲染层滑动窗口。两者是不同量：一个标注为估算（`~`、独立 tooltip），一个是协议事实，不存在互相竞争的"同一真相"。
- **为什么不让 CLI 周期性上报流式进度事件**：仓库不变量（`publishModelTelemetryMilestone` 处注释）规定纯观测事件不写 SessionEvent、不污染对话产品状态；每秒一次的进度事件会进入持久化 journal 与 replay/cold-hydration 路径，代价与该约束冲突。渲染层从自己已在消费的 row.delta 派生估算，是零协议、零持久化成本的路径。
- 估算公式与 CLI `estimateTokens`（apps/zcode-cli/packages/core/src/context/utils.ts）刻意保持一致；改公式必须两边同步。
- 轮询无重叠（上一次完成后再排下一次），切换任务后旧结果不得覆盖新任务（沿用 `useSessionDebug` 既有语义）。

## 接口

- 复用既有 `session/debug` RPC 与 `sessionDebugSnapshotSchema`，协议 schema **零变更**。
- CLI `querySessionDebug` 解析顺序：父会话活跃 record → detached child 观测 → `requireSession` 抛 `sessionUnavailable`。
- 子会话观测为进程内旁路（`Map<childSessionId, Observation>`，FIFO 上限 16，其余沿用 `SESSION_DEBUG_LIMITS`），不落盘、不进聊天投影；child 被 gateway 回收后观测随 FIFO 自然淘汰，已打开的窗格在淘汰前仍可读。

## 版本偏斜

- 旧 CLI + 新 UI：子会话查询报 `sessionUnavailable` → hook 置 error → 该位置静默隐藏，主会话功能不受影响。
- 新 CLI + 旧 UI：无行为变化。

## 验收场景

1. 发起对话，思考/正文流式期间「工作中」行右缘在 1 秒内出现 `~xx.x tok/s` 并持续随输出更新。
2. 流式静默（工具执行、请求间隙）超过约 2 秒后回落为不带 `~` 的精确值；每个模型请求完成时精确值刷新。
3. 只有工具执行、无任何流式与新增请求完成时数值保持不变；段完成后该数值消失。
4. 两个来源都无事实（首个请求未完成且样本跨度不足 / 吞吐未知）时不显示任何数值或占位。
5. 并发子 agent 运行时，状态面板 Agents 分区每行显示各自子会话的独立精确吞吐。
6. 打开子 agent 详情窗格，其「工作中」行显示子会话的估算与精确值（与主对话同组件）。
7. 手机 Web 远控（`web-remote-replayable`）恢复后同样可见（估算来自 row.delta，精确值来自 RPC 轮询，与链路无关）。
