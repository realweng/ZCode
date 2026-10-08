import type {
  ApiClient,
  OAuthCallbackParams,
  OAuthProviderId,
  OAuthProviderMeta,
  OAuthTokenSet,
  OAuthUserProfile,
} from "@zcode/shared";

/** Provider 执行上下文 */
export interface OAuthProviderContext {
  providerId: OAuthProviderId;
  state: string;
  redirectUri: string;
  now: () => number;
}

/** Device Code Flow 的发起结果（RFC 8628） */
export interface OAuthDeviceFlowStart {
  deviceCode: string;
  userCode: string;
  /** 已携带 user_code 的完整授权页地址；Desktop 直接打开它。 */
  verificationUriComplete: string;
  expiresAt: number;
  pollIntervalMs: number;
}

/** Device Code Flow 的单次轮询结果 */
export type OAuthDevicePollResult =
  | { status: "pending" }
  | { status: "slow-down"; nextIntervalMs: number }
  | { status: "token"; tokenSet: OAuthTokenSet }
  | { status: "denied" }
  | { status: "expired" };

/** OAuth provider 适配器：隔离协议差异 */
export interface OAuthProviderAdapter {
  readonly providerId: OAuthProviderId;
  readonly meta: OAuthProviderMeta;
  readonly redirectUri: string;
  readonly apiClient: ApiClient;

  parseCallbackParams(url: string): OAuthCallbackParams;
  buildAuthorizeUrl(context: OAuthProviderContext): string;
  exchangeToken(params: OAuthCallbackParams, context: OAuthProviderContext): Promise<OAuthTokenSet>;
  /** 将后端 polling 返回的 provider token 归一化为 Desktop 持久化语义。 */
  normalizePolledTokenSet?(tokenSet: OAuthTokenSet): Promise<OAuthTokenSet>;
  fetchUserInfo?(tokenSet: OAuthTokenSet, context: OAuthProviderContext): Promise<OAuthUserProfile>;
  refreshToken?(tokenSet: OAuthTokenSet, context: OAuthProviderContext): Promise<OAuthTokenSet>;

  /**
   * Device Code Flow（如 Kimi）：不走 zcode.z.ai 中转，也没有 zcode:// 深链回调。
   * OAuthService 的 startOAuthWithPolling/pollPendingOAuth 检测该方法后切换为直连轮询。
   */
  startDeviceFlow?(context: OAuthProviderContext): Promise<OAuthDeviceFlowStart>;
  pollDeviceToken?(
    deviceCode: string,
    context: OAuthProviderContext,
  ): Promise<OAuthDevicePollResult>;

  /** provider 级 legacy 凭据读取（用于升级兼容） */
  loadLegacyTokenSet?(
    loadCredential: (key: string) => Promise<string | null>,
  ): Promise<OAuthTokenSet | null>;

  normalizeError(error: unknown): Error;
}
