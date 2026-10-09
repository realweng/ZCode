# Kimi 账号用量展示

## 背景与目标

「使用统计 → 个人套餐」目前只有智谱账号的用量视图（额度卡、活跃度、趋势），登录 Kimi 后该 tab 无数据。本特性在保持单活账号语义的前提下，为 Kimi 账号提供可用的用量展示，数据源分为远端（Kimi 接口）与本地（应用用量，模型无关已含 kimi）。

## 可查询数据与来源

| 信息                                                     | 来源                                          | 说明                                                                    |
| -------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| 5 小时滚动窗口额度（limit/used/remaining/resetTime）     | `GET {origin}/coding/v1/usages` 的 `limits[]` | 等价于智谱「5 小时剩余」条                                              |
| 周配额（limit/used/remaining/resetTime，7 天周期不累积） | 同接口 `usage`                                | 周维度条                                                                |
| 限流状态（`limited`、并发上限 `parallel.limit`）         | 同接口                                        | 窗口打满即限流；以额度条 100% 呈现，不单独建字段                        |
| 会员等级（如 `LEVEL_INTERMEDIATE`）                      | `GET /coding/v1/me`                           | 额度卡 level 标签；best-effort，失败不阻塞快照                          |
| 本应用用量（累计 token/热力图/日趋势）                   | agent DB（`getAppUsageSnapshot`）             | 模型无关，kimi 已计入；「个人套餐」tab 活跃度块复用它，并以小字标注口径 |

接口约束：请求 `/usages` **必须带 `User-Agent: KimiCLI/1.6`**，否则返回 404（Spike 实测 + 非公开接口笔记）。该接口无公开文档，字段解析必须容忍未知键并防御性处理 resetTime 的秒/毫秒/ISO 三种形态。

## 状态所有者

| 状态                       | 唯一所有者                                                                   | 说明                                                               |
| -------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Kimi 额度/等级查询         | `KimiUsageQuotaProvider`（usage-stats/providers，与 BigModel provider 平级） | 复用同一 `UsageEntitlementSnapshot` 形状与 in-flight 合并/失败退避 |
| 鉴权 token                 | `OAuthService.resolveFreshOAuthTokenSet`                                     | 临期静默刷新；仅本地 host；只读                                    |
| 路由（按 providerId 选源） | `usageStatsService.getEntitlementSnapshot`                                   | kimi providerId → Kimi provider；其余 → BigModel provider          |
| 展示口径                   | `CodingPlanUsagePanel` kimi 分支                                             | 额度卡复用；活跃度块复用本地应用用量并标注口径                     |

## 不变量

1. Kimi 数据不得污染 zhipu 语义字段：`mcpQuota` 恒为 null；`snapshot.remaining` 只在 kimi 路由下取 kimi 窗口值。
2. `/usages` 失败一律抛错走统一失败退避，**不得**发布伪成功空快照（与 BigModel 同规则）。
3. 未登录 Kimi：`{ authenticated: false, unavailableReason: "not_configured" }`，不发请求。
4. 额度条映射固定：5 小时窗口 = `TOKENS_LIMIT, unit=3, number=5`；周配额 = `TOKENS_LIMIT, unit=6`；`percentage` 沿用「已用占比」口径，UI 反转成剩余。
5. Coding Plan 额度重置接口为智谱专有：kimi providerId 调 reset 系列方法必须显式拒绝，不允许落到 BigModel 域名。
6. 远端 monitor（活跃度/趋势/健康）无端点：kimi 视图隐藏这些块，不用本地数据伪造。

## 接口

- 服务：`KimiUsageQuotaProvider.getSnapshotForRequest(request)` → `UsageEntitlementSnapshot`（含 `quota.level`、`quota.limits[]`、`context.displayName = "Kimi Coding Plan · <level>"`）。
- `usageStatsService.getEntitlementSnapshot` 增加 kimi 路由；`SettingsPage` 个人套餐 source 构造按活跃 family 探测（登录 kimi 时构造 kimi source）。
- 侧栏用量横幅解除 kimi 排除，按活跃 family 显示窗口/周配额剩余。

## 验收场景

1. 登录 Kimi → 设置 → 使用统计 → 个人套餐：显示 5 小时窗口与周配额两条额度条（含重置时间）、会员等级，以及本地活跃度块。
2. 窗口打满（limited）→ 窗口条显示 100% 已用；周配额条不受影响（两套独立计数）。
3. 登出 Kimi → 同一页面显示 not_configured 提示而非空白或报错。
4. 侧栏横幅在 kimi 活跃时显示窗口/周剩余；切回智谱后恢复智谱额度展示。
5. Kimi 活跃时触发额度重置入口不可见；直接调用 reset 方法显式报错而非打到 BigModel 域名。
