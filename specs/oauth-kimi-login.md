# Kimi Code 单点登录(OAuth Device Flow)接入

## 目标与范围

- Desktop 端新增 Kimi(Moonshot)账号单点登录,覆盖两个区域:
  - `kimi`(中国大陆):OAuth host `https://auth.kimi.com`,API base `https://api.kimi.com/coding/v1`
  - `kimi-global`(Global):OAuth host `https://auth.kimi.ai`,API base `https://api.kimi.ai/coding/v1`
- 登录后 Kimi Coding Plan 模型可用(OpenAI 兼容 `openai-chat-completions`,Bearer access_token)。
- 不改动 CLI 与 Web 端登录;Web 分享页登录入口不含 Kimi。

## 产品规则

1. 登录面板新增两个入口:Kimi(中国大陆)、Kimi(Global),与 BigModel/Z.AI 并列,使用相同 regionTag 展示模式。
2. 登录协议为 OAuth 2.0 Device Code Flow(RFC 8628),不经过 zcode.z.ai,没有 `zcode://` 深链回调:
   - `POST {oauthHost}/api/oauth/device_authorization`(client_id + 设备头)→ `device_code`、`user_code`、`verification_uri_complete`、`expires_in`、`interval`
   - 打开系统浏览器访问 `verification_uri_complete`(自动携带 user_code,用户无需手输)
   - Host 轮询 `POST {oauthHost}/api/oauth/token`(`grant_type=urn:ietf:params:oauth:grant-type:device_code`)
   - 轮询语义:`authorization_pending` 继续、`slow_down` 间隔 +5s、`expired_token`/`access_denied` 终止报错、成功返回 token
3. 登录互斥:`oauth:active_provider` 是单一事实源。Kimi 任意区域登录成功时清理 zai/bigmodel/另一区域 kimi 的本地凭据;反向登录同理。
4. Token 生命周期:
   - `access_token` 短期(登录时落盘 `expiresAt`);
   - `refresh_token` 长期,用于静默刷新;
   - 模型请求期(反向 RPC 解析鉴权时)若 token 临期(≤5min)或过期,先刷新再返回;
   - 刷新返回 401/`invalid_grant` 时按登出处理,UI 提示重新登录。
5. 会话恢复:Kimi 无 zcode JWT。启动恢复只读缓存 `oauth:kimi*:user_info`,按已登录展示;token 有效性由请求期刷新兜底,不在恢复链路做远端校验。
6. 用户信息来自 `GET {apiBase}/me`(snake_case:`user_id`/`nickname`/`avatar`/`email`),失败不阻塞登录(与 bigmodel 语义一致)。
7. 模型列表静态内置(kimi-k2 系列),登录后不动态拉取 `/models`。

## 状态所有者

| 状态                               | 唯一所有者                                     | 说明                                                                 |
| ---------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| OAuth 凭据(access/refresh/profile) | `OAuthCredentialRepo`(`credentials.json` 加密) | key:`oauth:kimi:*`、`oauth:kimi-global:*`;不读写共享 `zcodejwttoken` |
| pending device flow                | `OAuthService.pendingState`                    | UI 每秒 `pollPendingOAuth` 驱动,`nextPollAt` 节流                    |
| token 刷新                         | Desktop `OAuthService.refreshToken`            | 单进程内 `runSessionMutation` 串行写回;runtime 无刷新能力            |
| 模型请求鉴权                       | Desktop `accountProviderRequestAuthService`    | runtime 每 attempt 反向 RPC 回 Desktop 解析,唯一决策点               |

## 接口

- `OAuthProviderAdapter` 新增可选 device-flow 方法:
  - `startDeviceFlow?(context)` → `{ verificationUriComplete, userCode, deviceCode, expiresAt, intervalMs }`
  - `pollDeviceToken?(deviceCode)` → `{ status: "pending" } | { status: "slow-down" } | { status: "token", tokenSet } | { status: "denied" } | { status: "expired" }`
  - `refreshToken?` 沿用现有可选方法(Kimi adapter 实现,Kimi 成为首个支持静默刷新的 provider)
- 协议(`packages/shared/src/zcode-protocol/index.ts`):
  - `zcodeAccountAccessSchema` 新增变体 `{ type: "kimi-account", family: "kimi", planKind: "kimi-coding-plan" }`
  - `zcodeProviderAccountAccessSchema`:`type` 增加 `"kimi-account"`,`accountType` 增加 `"kimi"`
- builtin provider(`config/provider/zcode-builtin.json`):
  - `account:kimi-coding-plan`、`account:kimi-global-coding-plan`(group `kimi-family`,api `openai-chat-completions`)
- 模型请求期鉴权:`planKind === "kimi-coding-plan"` 分支返回 `{ apiKey: kimiAccessToken }`(临期先刷新)。

## 时序图

### 登录(Device Code Flow)

```
UI(LoginPanel)            OAuthService(Host)                浏览器/auth.kimi.com
   │ startLogin("kimi")        │                                  │
   │──────────────────────────>│ startOAuthWithPolling            │
   │                           │  POST /api/oauth/device_authorization
   │                           │─────────────────────────────────>│
   │                           │  device_code/user_code/verification_uri_complete
   │                           │<─────────────────────────────────│
   │                           │ pendingState = { device flow }   │
   │ { authorizeUrl, state }   │                                  │
   │<──────────────────────────│                                  │
   │ openExternal(verification_uri_complete) ────────────────────>│ 用户授权
   │ (每秒 pollPendingOAuth)      │                                  │
   │──────────────────────────>│ POST /api/oauth/token (device_code)
   │                           │   authorization_pending → 继续等待 │
   │                           │   slow_down → interval += 5s      │
   │                           │   200 access_token → fetchUserInfo(/me)
   │                           │ persistOAuthSession(互斥清理+落盘) │
   │ session result             │                                  │
   │<──────────────────────────│                                  │
```

### 模型请求期鉴权与静默刷新

```
runtime(agent)             zcodeAgentService            accountProviderRequestAuthService   OAuthService
   │ 模型请求 attempt           │                              │                            │
   │──interaction/requestProviderRuntimeHeaders──>│              │                            │
   │                           │ resolveCurrent ─────────────>│ loadOAuthTokenSet("kimi")    │
   │                           │                              │ expiresAt 临期? ────────────> refreshToken()
   │                           │                              │<──────── 新 tokenSet ────────┤
   │                           │<──── { apiKey: accessToken }─│(repo 串行写回)              │
   │<─── requestAuth ──────────│                              │                            │
   │ Authorization: Bearer …   │(401 时:归因为 kimi 凭据 → 再刷新 → 仍失败则登出并提示重登)   │
```

## 验收场景

1. 未登录 → 登录面板出现 Kimi / Kimi Global 两个入口;点击后浏览器打开授权页;授权完成后 App 自动完成登录并展示用户信息(nickname/avatar)。
2. 授权页选择拒绝 → 轮询返回 `access_denied`,登录面板展示登录失败,无残留 pending flow。
3. device code 过期(15 分钟未完成授权)→ flow 收口并展示登录失败。
4. Kimi 登录后设置页出现 Kimi family 卡片;选择 kimi 模型发送消息可获得响应(OpenAI 兼容端点)。
5. `access_token` 过期后发送消息 → Desktop 静默刷新,请求成功,用户无感知。
6. `refresh_token` 失效(401/invalid_grant)→ 401 归因登出,UI 提示重新登录。
7. Kimi 登录态下登录 BigModel(或反向)→ 旧 provider 凭据被清理,`active_provider` 指向新 provider。
8. 登录后重启 App → 会话按缓存恢复,无需重新登录。

## 修正：双账号域一致性补齐（kimi-account）

初版接入只覆盖了协议层 union schema 与鉴权链，配置/解析/门禁/设置四层存在只认 `zhipu-account` 的漏网，登录 Kimi 后账号链路失效（与线上 100.0.8 的 `Invalid input: expected "zhipu-account"` 同型）。修正后的不变量：

1. 账号 Overlay 信封（`parseAccountProviderConfigMap`）必须同时接受 zhipu/kimi 两类 `{type, entitled}` 条目；新增账号变体时必须同步扩展该集合（`packages/provider/src/config/schema.ts`）。
2. 账号约束型判定（`isAccountConstrainedProvider`）= zhipu + kimi 两类；连接指向账号提供方不得抛错（`packages/provider/src/account-provider-resolution.ts`）。
3. `providerFamilyDomain` 枚举包含 `"kimi"`；登录写入与磁盘恢复都不能因枚举缺失失败或静默回退（`packages/shared/src/validationAppSettings.ts`）。
4. Registry 门禁对两类账号都走 `entitled`：`accessEntitled = 非账号型 || entitled === true`，未授权账号不得发布可执行模型（`packages/provider/src/resolver.ts`）。

回归测试：`packages/provider/test/accountProviderConfigMap.test.ts`、`packages/provider/test/accountProviderResolution.test.ts`、`packages/provider/test/registryResolverAccountEntitlement.test.ts`（真实内置配置驱动）、`packages/shared/test/validationAppSettings.test.ts`。
