import {
  ApiError,
  type ApiClient,
  type OAuthCallbackParams,
  type OAuthProviderMeta,
  type OAuthTokenSet,
  type OAuthUserProfile,
} from "@zcode/shared";
import { readApiJson } from "../../providers/api/apiJson.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";
import type { OAuthProviderRuntimeConfig } from "../runtimeConfig.js";
import type {
  OAuthDeviceFlowStart,
  OAuthDevicePollResult,
  OAuthProviderAdapter,
  OAuthProviderContext,
} from "./providerAdapter.js";

/** Kimi userinfo 接口最长等待时间；启动恢复链路不做远端校验，只在登录完成后读取一次。 */
const KIMI_USERINFO_TIMEOUT_MS = 30_000;
/** 设备码发起的最长等待时间 */
const KIMI_DEVICE_AUTHORIZATION_TIMEOUT_MS = 15_000;
/** 轮询默认间隔（秒）；服务端 interval 缺失时的兜底。 */
const KIMI_DEFAULT_POLL_INTERVAL_SEC = 5;
/** slow_down 后的追加间隔（秒），与 RFC 8628 建议一致。 */
const KIMI_SLOW_DOWN_EXTRA_SEC = 5;

const log = createServiceLogger("kimiOAuth");

interface KimiDeviceAuthorizationResponse {
  user_code?: unknown;
  device_code?: unknown;
  verification_uri?: unknown;
  verification_uri_complete?: unknown;
  expires_in?: unknown;
  interval?: unknown;
}

interface KimiTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
}

interface KimiTokenErrorResponse {
  error?: unknown;
  error_description?: unknown;
}

interface KimiUserInfoResponse {
  user_id?: unknown;
  nickname?: unknown;
  username?: unknown;
  email?: unknown;
  avatar?: unknown;
}

function readTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readPositiveSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** Kimi token 端点的鉴权头；直接复用 kimi-code CLI 的公开 client 语义。 */
function buildKimiDeviceHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "X-Msh-Platform": "zcode_desktop",
  };
}

/**
 * Kimi OAuth 协议适配器（OAuth 2.0 Device Code Flow, RFC 8628）。
 *
 * 与 zai/bigmodel 的差异：不经过 zcode.z.ai 中转、没有 zcode:// 深链回调，
 * authorizeUrl/redirectUri/state 都不参与协议；登录完成以轮询 token 端点为准。
 */
export class KimiProviderAdapter implements OAuthProviderAdapter {
  readonly providerId: OAuthProviderRuntimeConfig["id"];
  readonly meta: OAuthProviderMeta;
  readonly redirectUri: string;
  readonly apiClient: ApiClient;

  constructor(
    private config: OAuthProviderRuntimeConfig,
    apiClient: ApiClient,
  ) {
    this.providerId = config.id;
    this.meta = {
      id: config.id,
      displayName: config.displayName,
      enabled: config.enabled,
      order: config.order,
    };
    this.redirectUri = config.redirectUri;
    this.apiClient = apiClient;
  }

  async startDeviceFlow(context: OAuthProviderContext): Promise<OAuthDeviceFlowStart> {
    const payload = await readApiJson<KimiDeviceAuthorizationResponse>(
      this.apiClient,
      this.config.authorizeUrl,
      {
        method: "POST",
        timeoutMs: KIMI_DEVICE_AUTHORIZATION_TIMEOUT_MS,
        headers: buildKimiDeviceHeaders(),
        body: new URLSearchParams({ client_id: this.config.appId }).toString(),
      },
    );

    const deviceCode = readTrimmedString(payload.device_code);
    const userCode = readTrimmedString(payload.user_code);
    const verificationUriComplete =
      readTrimmedString(payload.verification_uri_complete) ||
      readTrimmedString(payload.verification_uri);
    const expiresInSec = readPositiveSeconds(payload.expires_in);
    if (!deviceCode || !userCode || !verificationUriComplete || !expiresInSec) {
      throw new Error("Kimi device authorization 响应无效");
    }

    return {
      deviceCode,
      userCode,
      verificationUriComplete,
      expiresAt: context.now() + expiresInSec * 1_000,
      pollIntervalMs:
        (readPositiveSeconds(payload.interval) ?? KIMI_DEFAULT_POLL_INTERVAL_SEC) * 1_000,
    };
  }

  async pollDeviceToken(
    deviceCode: string,
    context: OAuthProviderContext,
  ): Promise<OAuthDevicePollResult> {
    const response = await this.apiClient.request(this.config.tokenUrl, {
      method: "POST",
      headers: buildKimiDeviceHeaders(),
      body: new URLSearchParams({
        client_id: this.config.appId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
    });

    if (response.ok) {
      const payload = (await response.json()) as KimiTokenResponse;
      const accessToken = readTrimmedString(payload.access_token);
      if (!accessToken) {
        throw new Error("Kimi token 响应缺少 access_token");
      }
      const refreshToken = readTrimmedString(payload.refresh_token);
      const expiresIn = readPositiveSeconds(payload.expires_in);
      return {
        status: "token",
        tokenSet: {
          accessToken,
          ...(refreshToken ? { refreshToken } : {}),
          ...(expiresIn ? { expiresAt: context.now() + expiresIn * 1_000 } : {}),
        },
      };
    }

    let errorCode = "";
    let errorDescription = "";
    try {
      const payload = (await response.json()) as KimiTokenErrorResponse;
      errorCode = readTrimmedString(payload.error);
      errorDescription = readTrimmedString(payload.error_description);
    } catch {
      // 非 JSON 错误响应（网关错误页等）按通用失败处理。
    }

    if (errorCode === "authorization_pending") {
      return { status: "pending" };
    }
    if (errorCode === "slow_down") {
      return {
        status: "slow-down",
        nextIntervalMs:
          // RFC 8628 语义是"在当前间隔上加 5 秒"，具体基数由 OAuthService 持有。
          KIMI_SLOW_DOWN_EXTRA_SEC * 1_000,
      };
    }
    if (errorCode === "expired_token") {
      return { status: "expired" };
    }
    if (errorCode === "access_denied") {
      return { status: "denied" };
    }

    throw new ApiError({
      message: errorDescription || errorCode || `HTTP ${response.status}`,
      url: this.config.tokenUrl,
      method: "POST",
      status: response.status,
    });
  }

  async refreshToken(
    tokenSet: OAuthTokenSet,
    context: OAuthProviderContext,
  ): Promise<OAuthTokenSet> {
    const refreshToken = tokenSet.refreshToken?.trim();
    if (!refreshToken) {
      throw new Error("Kimi 账号缺少 refresh_token，请重新登录");
    }

    const payload = await readApiJson<KimiTokenResponse>(this.apiClient, this.config.tokenUrl, {
      method: "POST",
      headers: buildKimiDeviceHeaders(),
      body: new URLSearchParams({
        client_id: this.config.appId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
    });

    const accessToken = readTrimmedString(payload.access_token);
    if (!accessToken) {
      throw new Error("Kimi token 刷新响应缺少 access_token");
    }
    const nextRefreshToken = readTrimmedString(payload.refresh_token);
    const expiresIn = readPositiveSeconds(payload.expires_in);
    return {
      accessToken,
      // refresh token 轮换语义：服务端下发新值时替换；未下发时保留旧值，
      // 避免轮换实现不一致把唯一可用的 refresh token 清空。
      refreshToken: nextRefreshToken || refreshToken,
      ...(expiresIn ? { expiresAt: context.now() + expiresIn * 1_000 } : {}),
    };
  }

  async fetchUserInfo(
    tokenSet: OAuthTokenSet,
    _context: OAuthProviderContext,
  ): Promise<OAuthUserProfile> {
    const payload = await readApiJson<KimiUserInfoResponse>(
      this.apiClient,
      this.config.userinfoUrl,
      {
        method: "GET",
        timeoutMs: KIMI_USERINFO_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${tokenSet.accessToken}`,
          Accept: "application/json",
        },
      },
    );

    const id = readTrimmedString(payload.user_id) || "unknown";
    const username =
      readTrimmedString(payload.nickname) ||
      readTrimmedString(payload.username) ||
      readTrimmedString(payload.email) ||
      id;
    return {
      id,
      username,
      displayName: username,
      ...(readTrimmedString(payload.avatar)
        ? { avatarUrl: readTrimmedString(payload.avatar) }
        : {}),
    };
  }

  // 以下两个方法为深链回调协议所要求，Kimi device flow 不会触发；
  // 若被调用说明状态机串线，显式抛错而不是静默返回空。
  parseCallbackParams(_url: string): OAuthCallbackParams {
    throw new Error("Kimi 登录使用 Device Code Flow，不支持深链回调");
  }

  buildAuthorizeUrl(_context: OAuthProviderContext): string {
    throw new Error("Kimi 登录使用 Device Code Flow，authorizeUrl 由 startDeviceFlow 返回");
  }

  exchangeToken(): Promise<OAuthTokenSet> {
    return Promise.reject(new Error("Kimi 登录使用 Device Code Flow，不支持授权码交换"));
  }

  normalizeError(error: unknown): Error {
    if (error instanceof ApiError) {
      return error;
    }
    if (error instanceof Error) {
      return error;
    }
    return new Error(`Kimi OAuth 异常: ${String(error)}`);
  }
}

// 保留 logger 引用：后续排查 device flow 现场时可快速启用 debug 记录。
void log;
