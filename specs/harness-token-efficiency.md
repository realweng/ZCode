# Harness Token Efficiency（融合 SoL-Pi 核心机制）

> 状态：设计提案（未实现）。基于对 [NVlabs/SoL-Pi](https://github.com/NVlabs/SoL-Pi)（MIT, NVIDIA "Scaling Auto-Research Loops for Efficient Agent Harnesses"）源码级调研与 ZCode harness 现状对照。实现前需与维护者对齐范围与阶段。

## 1. SoL-Pi 的设计思想

SoL-Pi 的命题是「少花钱，但不让 agent 少干活」：不做提前停止、不跳过验证、不隐藏证据，而是消除 harness 的结构性浪费：

- 编辑后可预测的验证命令要占用一整个 frontier-model turn；
- 大体积工具结果在每次 provider request 中重复传输（prompt cache 只省读不省写）；
- 已完成子任务的上下文长期滞留；
- 昂贵模型 turn 花在读长日志上，而其中只有几行有意义。

四条工程原则（对 ZCode 同样适用）：

1. **No patches**：只用宿主 agent 的公开机制，不接管 auth/provider/model/shell。
2. **Explicit opt-in**：一切默认关闭，单一 JSON 配置、无环境变量。
3. **Preserve evidence**：原始观测始终本地可回读；任何缩减失败则原样保留（fail-open 保数据）。
4. **Respect the runtime**：鉴权、计费、模型路由全部复用宿主既有通道。

两个更深层的思想值得单独点名：

- **证据保全协议**：把 LLM 输出与日志内容当作不可信输入。归约产物（receipt）只有在每条引文都能对归档原文逐字节验证通过时才允许替换原结果；`status` 必须镜像原始 `is_error`；原文有失败特征而 receipt 没有失败证据时直接拒绝（防止把真实失败"洗白"成干净摘要）。
- **压缩经济学**：压缩不是「窗口满了才压」，而是显式建模 prompt-cache 读写差价——压缩使缓存失效、重写上下文要付 cache-write 溢价，只有摊销期 ≤ 剩余请求预期时才值得压；窗口压力保护作为绝对优先级绕过一切经济学。

## 2. 四机制技术拆解（源码确认）

### 2.1 Action Fusion（编辑 + 验证融合）

- 包装（替换）内置 edit/write 工具，schema 增加可选 `command`（后随验证命令）与 `timeout`。
- 执行序：mutation → SHA-256 稳定性断言（mutate 后 hash → `setImmediate` 让渡一次事件循环 → 再 hash，不一致即报「目标内容在融合变更后被修改」）→ 以 toolCallId `${toolCallId}:then_run` 调用宿主 bash 工具执行命令。
- 结果合并标记：`[then_run:succeeded]` / `[then_run:failed]` / `[then_run:skipped]`（mutation 失败时命令不执行，标 skipped）。bash 失败时错误里同时携带 mutation 输出与命令错误。
- 并发：按 canonical 路径（realpath 归一）的 per-file promise 队列串行化，同一文件的两个融合变更不可交错。

### 2.2 ObservationPack（观测句柄化 + 精确分页召回）

- 挂在 provider-context 投影层（`on("context")`）：**只改投影，不改持久化历史**——压缩/resume 后召回依然可用。
- 准入：role 为 toolResult、非 error、全部为文本 block、拼接后 > 10 KiB；已是 EPR receipt 的不再打包。
- 身份与存储：`obs_` + SHA-256(toolName \0 toolCallId \0 contentHash) 前 24 hex；内容寻址对象存 `<session-root>/observation-pack/objects/<id>.txt`，`O_EXCL|O_NOFOLLOW`、目录 0o700 / 文件 0o600，EEXIST 时校验 size+hash。
- 替换时机：**前 2 次 provider request（FULL_SENDS）全量发送**，之后替换为占位符：元数据（id/tool/original_bytes/original_lines/estimated_tokens）+ 召回提示 + 首 512B/尾 512B 整行摘录 + `[N original bytes omitted]`。
- 召回：`obs_recall` 工具，`{id, offset}`，单次上限 16 KiB / 400 行（扣除头部预留），返回体带 `next_offset` 与 `eof` 支持顺序分页。
- 审计：JSONL ledger 记录每次 full/placeholder/recall；打包失败 fail-open（结果原样保留）。

### 2.3 Evidence-Preserving Reducer（证据保全归约）

- 候选：bash 结果（command 非空），或融合 edit/write 中 `[then_run:*]` 标记之后的日志体；优先读未截断的 fullOutputPath（严格校验：文件名模式 + realpath 后位于 tmp 根 + 非符号链接的常规文件）。
- 归约：辅助模型（可配置路由，宿主托管鉴权）把日志压成一个 JSON receipt：`{schema, source_sha256, status, uncertain, evidence:[{kind, quote}]}`，kind ∈ fatal|failure|warning|target|summary；prompt 明示日志为 untrusted、只输出 JSON、不做诊断/修复建议。
- 验证协议（全部通过才替换原结果）：JSON 合法 → schema/sha/status 镜像 is_error → 每条 quote 必须是归档原文的逐字节子串（`body.includes(quote)`，含条数与单条长度上限）→ 原文命中失败特征而 isError=true 时 evidence 必须含 fatal/failure。任何一步失败：原结果不变。
- 文本 receipt：key=value（status/uncertain/command_sha256/source_sha256/bytes/lines/artifact 路径/reducer 用量）+ `verified_evidence:` 列表（kind/line/quote_sha256/quote），并附「诊断、修复、重跑、通过与否的裁决权保留给主模型；需要精确上下文时按字节/行范围读 artifact」。
- 归约失败（模型不可用、验证不过）→ 原样透传，不降级链路。

### 2.4 Online Context Compact（边界驱动 + 经济学的在线压缩）

- 边界检测：包装 `update_plan` 工具，步骤快照严格校验（≤128 步、字符串 ≤16 KiB、id 唯一）；「刚完成」= 同一 id 从非 completed 变为 completed（新引入的 completed 只算历史不算迁移）；完成事件记录 boundary + 进度摘要。
- 决策（turn_end 门）：估算剩余请求数（以历史 boundary 间隔的均值/方差下界，窗口上限 (window−context)/增量）；经济学公式：`saving = archiveTokens − memoTokens`，`incrementalCacheCostRatio = max(0, cacheWriteReadRatio − 1)`，`newDebt = postCompactionTokens × ratio`，`breakeven = newDebt / saving`；首次压缩 horizon×2 门槛，后续需 base + 1.5×margin + carried-debt 三重检验；压缩后 ≥2 次 request 冷却；`contextTokens ≥ window − 16_384` 时窗口保护绕过一切。另有「plan 唱空不能解锁被拒的压缩」规则（compactionRefused 只被成功的非 plan 工具结果重置）。
- 执行：决策通过后 `context.abort()` 延迟到 agent_settled 屏障再触发原生 compaction（带自定义摘要指令），成功后以隐藏消息 + `triggerTurn: true` 自动续跑「从当前计划继续剩余工作」，保持步骤 id 不变；状态以版本化 custom entries 存 session log。

## 3. ZCode harness 现状对照

| SoL-Pi 机制 | ZCode 已有 | 缺口 |
| --- | --- | --- |
| Action Fusion | 单 step 多 toolCall 并行批、流内 readOnly 工具提前执行（`streaming-tool-coordinator.ts`）、工具依赖分组（`core/tool/scheduler.ts`） | edit/write 无「后随验证命令融合进同一 tool call」的语义 |
| ObservationPack | resultBudget truncate/artifact 双策略 + artifactPath 引用 + `formatPersistedModelContent`（`core/tool/executor/result-serialization.ts`）；ToolArtifactStorePort 会话级落盘；microcompact 清旧结果 | 无「稳定句柄 + 精确分页召回」：artifact 只服务持久化预览；microcompact 是硬清空（`[Old tool result content cleared]`）且不可回读 |
| EPR | 全量输出已落 artifact；辅助模型调用范式现成（`workspace-generate-text.ts` → `createRuntimeModel` + `auxiliaryModelOptions` 最低推理档 + `runWithModelInvocationContext` 统一鉴权计费） | 无模型侧日志归约，无引文验证 receipt 协议 |
| OCC | auto/reactive/manual 三级 compact、microcompact、rapid-refill 熔断、context-usage 分类 breakdown、cache-control 锚点与 cacheStats、compact 后 plan 文件回注；**compact 在 model step 边界自动进行，turn 内天然续跑**（优于 Pi，无需 triggerTurn/settlement barrier 补丁） | 触发只有窗口压力阈值，无语义边界（TodoWrite 步骤完成）候选；无 cache 读写差价经济学；无 boundary 粒度的摘要选择 |

其他关键事实：

- ZCode **没有** Pi 式进程内 extension API：hooks 仅 7 个事件（SessionStart/UserPromptSubmit/PreToolUse/PermissionRequest/PostToolUse/PostToolUseFailure/Stop），插件不能替换内置工具或改写结果载荷。因此融合只能作为 harness 一等模块实现（符合 No-patches 的精神：走 seam，不改 provider/鉴权层）。
- 权威历史（`MessageHistoryImpl`）与 query-local 投影（`turnRequestState.entries` → `buildRuntimeProviderRequestMessages`）双轨已就绪——ObservationPack 需要的「投影层变换」有天然落点。
- 配置分层（user `~/.zcode/cli/config.json` → project `.zcode/` → env）与 `RuntimeConfig.features` 布尔位现成；ZCode 原则「能用配置表达的不用环境变量」与 SoL-Pi 一致。
- 远程双链路约束：desktop-continuous 与 web-remote-replayable。投影层机制不改持久化历史，replay 不受影响；召回/读 artifact 都经 CLI runtime 执行，手机远控天然可用。

## 4. 融合设计

### 4.0 总则

- 新模块 `apps/zcode-cli/packages/core/src/harness-efficiency/`，通过既有 seam 接入（投影管道、工具 schema、序列化预算、compact policy），不新建平行的状态写入路径。
- 四个开关默认 false（opt-in）：`features.observationPack` / `features.actionFusion` / `features.evidenceReducer` / `features.boundaryCompact`（`contracts/config/index.ts` RuntimeConfig.features 扩展，bootstrap `runtime-config.ts` 透传到 `AgentRuntimeConfig`）。`cacheWriteReadRatio`（默认 12.5）挂 `AutoCompactPolicyConfig`。EPR 模型路由复用 `auxiliaryModelOptions` 通道，不新增凭据配置。
- 单文件 ≤400 行，按 projection/objects/recall/receipt/economics 拆分。

### 4.1 P1：ObservationPack（句柄化投影 + ObsRecall 分页）

**产品规则**

- 准入：纯文本、非 error、>10 KiB 的 tool result；receipt（P4 引入后）不再打包。
- 前 2 次 provider request 全量发送；此后在 `buildRuntimeProviderRequestMessages` 投影管道中替换为占位符（元数据 + 首/尾 512B 整行摘录 + 省略标注）。
- 归档：内容寻址对象走 ToolArtifactStorePort 扩展（retention 同会话级；hash 校验同 SoL-Pi）；跨平台文件语义经统一 fs 入口（Windows 无 `O_NOFOLLOW` 时退化为 stat/lstat 校验 + 拒绝重解析点）。
- 召回工具 `ObsRecall`：`{id, offset}`，16 KiB/400 行单次上限，返回 `next_offset`/`eof`。
- 打包失败 fail-open。与 microcompact 的分工：obs-pack 管「体积维度」（大结果句柄化，可召回），microcompact 管「时间维度」（陈旧结果清空）；microcompact 清空前若对象已归档，清空标注保留 id，召回仍可用。

**状态所有者与事件顺序**

```text
权威历史（不变）：MessageHistory / turnRequestState.entries / SQLite parts
投影层（新增派生态）：
  buildRuntimeProviderRequestMessages(messages)
    → observation-pack projection（owner：core/harness-efficiency，per-session 内存态）
        ├─ 首次命中：archive 到 artifact store（O_EXCL + hash 校验），记 full，计数 +1
        ├─ 计数 ≤ 2：原样通过
        └─ 计数 > 2：替换为占位符（仅投影，持久化 parts 不动）
  ObsRecall(id, offset) → CLI runtime 读归档对象 → 分页文本
```

- 计数状态为**投影层派生态**：丢失只导致多全量发送两次（性能降级，非正确性问题）。resume 后计数重置为 0（安全默认）；持久化计数（SessionEvent versioned entry）列为后续优化，不在首期。

**验收场景**

1. 10 KiB 以下的 tool result 永不被替换。
2. 大结果前两次请求全量出现；第三次起 provider 请求中为占位符，持久化历史与远程 replay 仍为原文。
3. `ObsRecall` 按 offset 顺序分页可完整还原原文，`eof` 精确；未知 id 报错。
4. 归档写失败时结果原样进入上下文，会话不中断。
5. compact / rewind / resume 后召回依然可用（对象按内容寻址复用）。

### 4.2 P2：Action Fusion（Edit/Write 原生 thenRun）

**产品规则**

- `Edit`/`Write` 的 inputSchema 增加可选 `thenRun: { command: string, timeoutMs?: number }`；模型提示词同步说明「编辑后需要立即验证时，把验证命令并入同一次调用」。
- 执行序：mutation 成功 → SHA-256 稳定性断言（hash → 让渡一次事件循环 → hash）→ 经统一子进程执行入口运行 command（复用 Bash handler 的执行链与截断预算）→ 以 `[then_run:succeeded|failed|skipped]` 标记合并进同一 tool result。mutation 失败则命令不执行（skipped）。
- 标记字符串为稳定协议常量（P4 的 EPR 依赖它定位日志体）。
- 并发：不另建 per-file 队列，向现有 `tool/scheduler.ts` 声明同目标路径写互斥（复用唯一调度所有者，避免两条串行化路径）。
- 权限：thenRun 命令沿用 Bash 的权限裁决通道（单独审批，不因融合而绕过）。

**验收场景**

1. `thenRun` 缺省时 Edit/Write 行为与现状完全一致（默认零影响）。
2. mutation 失败 → 结果含 skipped 标记且命令未执行；命令失败 → 结果同时含 mutation 输出与命令错误。
3. 同文件两个融合调用不交错；断言检测到外部并发修改时报错而非静默覆盖。
4. thenRun 命令经过与 Bash 相同的权限审批与输出截断。

### 4.3 P3：Compact 经济学 + TodoWrite 边界（增强现有 compact）

**产品规则**

- 触发分两档：窗口压力档（现 `shouldAutoCompact`，语义不变，绝对优先）；**边界经济档**（新增）：TodoWrite 结果处检测「步骤刚完成」（同一 id 非 completed → completed；新引入的 completed 不算），记录 boundary 候选；在 model step 边界评估经济学。
- 经济学（照搬 SoL-Pi 公式与常量族）：`cacheWriteReadRatio`（配置，默认 12.5）；`saving = 可归档 token − memo token`；`breakeven = postCompaction × max(0, ratio−1) / saving`；首次压缩 horizon×2；后续 base + 1.5 margin + carried debt 三重检验；压缩后 ≥2 请求冷却。horizon 由历史 boundary 间隔估计。
- `selectInitialCompactEntriesForActiveConversation` 感知 boundary：优先在已完成步骤的边界处切分保留窗口，进度摘要（步骤粒度）进入 compact 摘要输入。
- 压缩后无需自动续跑补丁：ZCode 的 autoCompact 在 turn-loop model step 边界执行，回合天然继续（这是相对 Pi 的架构优势，triggerTurn/settlement barrier 不引入）。
- 记账 owner 为现有 compact 状态（turn-loop-state / 熔断所在），不新建并行状态机。

**验收场景**

1. features.boundaryCompact 关闭时 compact 行为与现状逐字节一致。
2. 窗口压力到达时无论经济学结论如何都压缩（保护优先）。
3. ratio 极大（cache 写极贵）时边界压缩被推迟，理由可观测（决策原因落 debug 日志）。
4. 冷却期内不重复压缩；boundary 摘要保留步骤 id，压缩后模型能按计划继续而不重做已完成步骤。

### 4.4 P4：Evidence-Preserving Reducer（receipt 归约）

**产品规则**

- 候选：Bash 结果（command 非空）与 `[then_run:*]` 之后的日志体；优先读 artifact 全量（路径来源 `ToolResultSerialization.artifactPath`，沿用严格校验）。
- 归约走 `generateWorkspaceText` 范式（aux 模型最低推理档，统一鉴权/计费/traceId）；prompt 明示 untrusted log、JSON-only、无诊断。
- 验证协议完整照搬（schema id、source_sha256、status 镜像 is_error、逐条 `includes(quote)`、missing-failure-evidence、条数/长度上限）；**任何失败原样透传**。
- receipt 文本进入上下文，原文留在 artifact（含按行范围回读指引）；receipt 不再被 obs-pack 二次打包。
- 默认路由为当前 provider 的 aux 模型（不引入独立凭据/远端路由配置；「必须本地的日志不送远端」的告警语义由此默认满足，独立远端路由列为后续开放问题）。

**验收场景**

1. 模型不可用/超时/验证不过 → 原结果原样进入上下文（fail-open）。
2. 构造含失败特征的日志，receipt 缺 failure 证据 → 拒绝替换。
3. quote 与归档差一个字节 → 拒绝替换。
4. receipt 中 command_sha256/source_sha256 与归档一致；按 receipt 的行号回读 artifact 能命中引文。

## 5. 路线图与优先级

1. **P1 ObservationPack**：省 token 最直接、纯本地、零额外模型调用；复用 artifact store + 投影 seam；顺带补齐 microcompact 不可召回的短板。
2. **P2 Action Fusion**：省整 turn、纯本地、实现面小；与 SoL-Pi 官方保守推荐（只开这两项）一致。
3. **P3 Compact 经济学**：增强现有链路，不新增状态路径。
4. **P4 EPR**：唯一引入额外模型调用的机制，最后做；效果用 usage-observability + context-usage breakdown 做前后基准（对齐 SoL-Pi 的 benchmark 文化）。

每阶段独立可开/关、可单独回滚；全链默认关闭，等价于现状。

## 6. 风险与明确不照搬的部分

- **不引入 Pi 式进程内插件 API**：融合为一等模块。若未来要做「第三方可挂载的结果变换」，应先设计契约（schema 校验 + 命名空间隔离 + 权限收口），不作为本提案范围。
- **不引入 sol-pi.json 独立文件**：ZCode 已有配置分层与 features 深合并，不另立文件格式与「替换式合并」语义。
- **不引入 triggerTurn / settlement barrier**：ZCode turn-loop 已内建压缩后续跑。
- **投影替换 × 前缀缓存**：句柄化会使替换点之后的缓存失效一次；由 FULL_SENDS=2 与经济学门槛（P3）约束频率；实现时需与 cache-control 锚点（`finalizeLatestNonSystemMessageCacheControl`）联测。
- **双链路**：投影层不改持久化历史，web-remote-replayable 的恢复语义不受影响；ObsRecall/receipt 回读均经 CLI runtime，手机远控可用。需 E2E 验证。
- **跨平台**：归档/分页的文件语义按「外部 I/O 边界收敛」走统一入口并补 Windows 测试。
- **安全**：receipt 协议把模型输出当不可信输入（hash + 逐字节验证）；日志、receipt、ledger 中不得出现凭据与内部地址（遵循日志规范）。
