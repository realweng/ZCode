# Session Token Throughput（tok/s 实时吞吐展示）

## 产品规则

- 主对话每个工作段的「工作中 N 分 N 秒」行，右缘对齐显示最近一次**已完成**模型请求的输出吞吐 `xx.x tok/s`。
- 数值口径与开发者工具面板 TPS 列完全同源同口径：`outputTokens / (durationMs - timeToFirstContentMs)`（`calculateOutputTps`，`packages/shared/src/session-debug.ts`）。
- 仅 `workStatus.state === "running"` 时显示；段完成后随「已工作 N」切换一并消失。
- 无事实时不渲染：没有 round、或最近 round 的 `tokensPerSecond === null`（未知解码时长）时整段隐藏，绝不显示 `0 tok/s` 或本地估算值。
- 工具执行期间（两次模型请求之间）保持上一次的数值；该值代表「最近一次完成的请求」，不是对当前流式请求的实时采样。
- 子 agent 两个位置显示**子会话自己的**吞吐：
  1. 状态面板 Agents 分区的每条运行行（时长旁）；
  2. 子会话右侧详情窗格内的「工作中」行（与主对话同一组件，自动生效）。

## 状态所有者与事件顺序

```text
ModelNetworkStatus(model_request_completed, querySource=main_turn)
  → CLI agent 进程 session-debug 观测（唯一事实源，含 usage/durationMs/TTFT）
      ├─ 父会话：observeSessionDebug(record, event)          （既有，不变）
      └─ 子会话：observeDetachedChildSessionDebug(id, event)  （新增，server-operations 子会话分支）
  → UI useSessionDebug 1s 轮询 session/debug RPC（只读，不反向写）
  → useSessionThroughput 取 rounds.at(-1).tokensPerSecond
  → AssistantHistoryStatus / SubagentStatusSection 渲染
```

- UI 不做本地 Δtoken/Δt 推导，避免出现第二条与 agent 事实竞争的吞吐真相。
- 轮询无重叠（上一次完成后再排下一次），切换任务后旧结果不得覆盖新任务（沿用 `useSessionDebug` 既有语义）。

## 接口

- 复用既有 `session/debug` RPC 与 `sessionDebugSnapshotSchema`，协议 schema **零变更**。
- CLI `querySessionDebug` 解析顺序：父会话活跃 record → detached child 观测 → `requireSession` 抛 `sessionUnavailable`。
- 子会话观测为进程内旁路（`Map<childSessionId, Observation>`，FIFO 上限 16，其余沿用 `SESSION_DEBUG_LIMITS`），不落盘、不进聊天投影；child 被 gateway 回收后观测随 FIFO 自然淘汰，已打开的窗格在淘汰前仍可读。

## 版本偏斜

- 旧 CLI + 新 UI：子会话查询报 `sessionUnavailable` → hook 置 error → 该位置静默隐藏，主会话功能不受影响。
- 新 CLI + 旧 UI：无行为变化。

## 验收场景

1. 发起对话，首个模型请求完成后 1–2 秒内「工作中」行右缘出现 `xx.x tok/s`，随每个后续请求完成而刷新。
2. 只有工具执行、无新请求完成时数值保持不变；段完成后该数值消失。
3. 吞吐未知（`tokensPerSecond === null`）时不显示任何数值或占位。
4. 并发子 agent 运行时，状态面板 Agents 分区每行显示各自子会话的独立吞吐。
5. 打开子 agent 详情窗格，其「工作中」行显示子会话吞吐。
6. 手机 Web 远控（`web-remote-replayable`）恢复后同样可见（数据来自 RPC 轮询，与链路无关）。
