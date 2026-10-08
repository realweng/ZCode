import {
  KIMI_GLOBAL_PROVIDER_ID,
  KIMI_PROVIDER_ID,
  resolveKimiApiBaseUrl,
  resolveKimiOAuthClientId,
  resolveKimiOAuthOrigin,
} from "@zcode/shared";
import type { OAuthProviderRuntimeConfig } from "../runtimeConfig.js";
import { readBoolean } from "./configUtils.js";

export type KimiOAuthRegion = "mainland-cn" | "global";

/**
 * Kimi 走 OAuth Device Code Flow，authorizeUrl/tokenUrl 不参与请求（无 zcode 中转、无深链），
 * 仅用于满足通用 runtime config 结构；真实端点在 adapter 内按 oauthHost 拼装。
 */
export function createKimiProviderRuntimeConfig(
  env: NodeJS.ProcessEnv,
  region: KimiOAuthRegion,
): OAuthProviderRuntimeConfig {
  const isGlobal = region === "global";
  const providerId = isGlobal ? KIMI_GLOBAL_PROVIDER_ID : KIMI_PROVIDER_ID;
  const oauthOrigin = resolveKimiOAuthOrigin(env, region);
  return {
    id: providerId,
    displayName: isGlobal ? "Kimi" : "Kimi",
    enabled: readBoolean(env, isGlobal ? "KIMI_GLOBAL_OAUTH_ENABLED" : "KIMI_OAUTH_ENABLED", true),
    order: isGlobal ? 3 : 2,
    authorizeUrl: `${oauthOrigin}/api/oauth/device_authorization`,
    tokenUrl: `${oauthOrigin}/api/oauth/token`,
    userinfoUrl: `${resolveKimiApiBaseUrl(env, region)}/me`,
    appId: resolveKimiOAuthClientId(env),
    // Device flow 没有 redirect；字段仅为满足接口形状，不参与任何请求。
    redirectUri: "",
  };
}
