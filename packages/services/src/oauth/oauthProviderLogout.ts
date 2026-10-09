import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  ZAI_PROVIDER_ID,
  type OAuthProviderId,
} from "@zcode/shared";
import { accountProviderCredentialKey } from "../model-provider/accountProviderCredentialKey.js";
import type { AccountProviderCredentialStore } from "../model-provider/accountProviderCredentialStore.js";

interface OAuthProviderLogoutDependencies {
  readonly accountProviderCredentialStore: Pick<AccountProviderCredentialStore, "deleteApiKey">;
  readonly refreshAccountProviders?: (reason: string) => Promise<unknown>;
}

export function createOAuthProviderLogoutHandler(
  dependencies: OAuthProviderLogoutDependencies,
): (provider: OAuthProviderId, accountIdentity?: string | null) => Promise<void> {
  return async (provider, accountIdentity) => {
    const providerIds = resolveProviderIds(provider);

    // Bug 根因：kimi 在 resolveProviderIds 返回 null 后提前 return，refreshAccountProviders
    // 不触发，账号 provider 视图残留已登出状态。kimi 无派生凭据可清，但刷新必须执行。
    if (providerIds && accountIdentity?.trim()) {
      await dependencies.accountProviderCredentialStore.deleteApiKey(
        accountProviderCredentialKey({
          providerId: providerIds.codingPlan,
          planKind: "individual-coding-plan",
          accountIdentity,
        }),
      );
    }
    await dependencies.refreshAccountProviders?.(`oauth-logout:${provider}`);
  };
}

function resolveProviderIds(provider: OAuthProviderId): {
  readonly codingPlan: string;
} | null {
  if (provider === ZAI_PROVIDER_ID) {
    return {
      codingPlan: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    };
  }
  if (provider === BIGMODEL_PROVIDER_ID) {
    return {
      codingPlan: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    };
  }
  // Kimi 没有独立存储的 coding plan API key（OAuth token 直接作为 Bearer），
  // 登出时仅刷新账号 provider 视图，无派生凭据可清。
  return null;
}
