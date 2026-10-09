import type {
  OAuthCachedSessionRestoreResult,
  OAuthCallbackResult,
  OAuthProviderId,
  OAuthProviderMeta,
  OAuthStartResponse,
  UserInfo,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * OAuth 认证服务
 *
 * 在 host process 中运行，负责 OAuth 流程的全部业务逻辑：
 * provider 管理、state 生命周期、token 交换、凭据存储。
 */
export interface IOAuthService {
  /** 获取可用 provider 列表（仅返回 enabled=true） */
  getProviders(): Promise<OAuthProviderMeta[]>;

  /** 获取当前 active provider */
  getActiveProvider(): Promise<OAuthProviderId | null>;

  /** 启动时从本地缓存恢复会话展示态：成功返回用户信息，不做远端 token 校验 */
  restoreCachedSession(): Promise<UserInfo | null>;

  /** 恢复本地展示态，并区分从未登录与 JWT 过期后需要重新认证。 */
  restoreCachedSessionState(): Promise<OAuthCachedSessionRestoreResult>;

  /** 显式校验当前 provider 会话：成功返回用户信息，失败或过期返回 null */
  restoreSession(): Promise<UserInfo | null>;

  /**
   * 发起 OAuth：指定 provider，生成 state，返回 authorize URL
   * state 由 renderer 上报给 main process 用于 deep link 路由
   */
  startOAuth(provider: OAuthProviderId): Promise<OAuthStartResponse>;

  /** 使用后端短期 flow 发起 OAuth；当前仅 Z.AI 支持，其他 provider 保持原流程。 */
  startOAuthWithPolling(provider: OAuthProviderId): Promise<OAuthStartResponse>;

  /** 查询当前后端 OAuth flow；未到查询时间、仍 pending 或没有 flow 时返回 null。 */
  pollPendingOAuth(): Promise<OAuthCallbackResult | null>;

  /**
   * 处理 OAuth 回调：校验 state；带 code 时换 token 并存凭据，只带归因参数时持久化归因信息
   * 已接收回调因取消或新 flow 失效时返回 null，由调用方静默忽略。
   * @param url - 完整 deep link URL
   */
  handleCallback(url: string): Promise<OAuthCallbackResult | null>;

  /**
   * 刷新 token
   * @param provider - 可选；不传时使用 active provider
   */
  refreshToken(provider?: OAuthProviderId): Promise<void>;

  /**
   * 登出 provider
   * @param provider - 可选；不传时登出 active provider
   */
  logout(provider?: OAuthProviderId): Promise<void>;

  /** 登出所有 provider */
  logoutAll(): Promise<void>;

  /**
   * 账号快捷切换（单活语义）：切回目标 family 已持久化的登录态，无需重新走 OAuth。
   * 目标 provider 不可用或本地无凭据时返回 login-required，由 UI 引导走登录流程。
   * 切换只改 active provider 与会话代际；域设置、账号视图刷新由 UI 侧复用既有链路完成。
   */
  switchAccountFamily(provider: OAuthProviderId): Promise<OAuthAccountSwitchResult>;

  /** 列出本地仍有持久化登录档案的 provider（跨 family 凭据共存的现状事实）。 */
  listPersistedOAuthProviders(): Promise<OAuthProviderId[]>;

  /**
   * 取消 pending OAuth
   * @param provider - 可选；不传时取消当前 pending
   */
  cancelPending(provider?: OAuthProviderId): Promise<void>;
}

export const IOAuthService = createServiceDescriptor<IOAuthService>(ServiceChannels.OAuth);

/** 账号快捷切换结果：switched = 已切回持久化登录态；login-required = 需要走登录流程。 */
export type OAuthAccountSwitchResult =
  | { kind: "switched"; provider: OAuthProviderId }
  | { kind: "login-required"; provider: OAuthProviderId };
