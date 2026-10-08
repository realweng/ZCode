import type { ProviderSettingsView } from "@zcode/services";
import {
  isZhipuModelProviderFamilyId,
  resolveModelProviderFamilySpecByProviderId,
  type ModelProviderFamilyId,
} from "@zcode/shared";
import type { UseUsageEntitlementOptions } from "@/hooks/useUsageEntitlement.js";
import { resolveAccountProviderInspectionAccess } from "@/lib/accountProviderAccess.js";
import { buildUsageEntitlementCacheKey } from "@/lib/usageEntitlementCache.js";

/** 设置、输入框与提交推荐复用原权益缓存；账号身份由 Account Source 的连接指纹提供。 */
export function buildStartPlanEntitlementOptions(
  view: ProviderSettingsView | null | undefined,
  providerId: string,
): UseUsageEntitlementOptions {
  const inspection = resolveAccountProviderInspectionAccess(view, providerId);
  const provider = view?.providers.find((entry) => entry.providerId === providerId);
  const familySpec = resolveModelProviderFamilySpecByProviderId(providerId);
  // Start Plan 权益仅存在于 zhipu 域；Kimi 域调用方传入时按无权益禁用来避免构造非法 access。
  // 显式收窄到 zhipu family id，accountAccess 的 family 字段不接受 "kimi"。
  const familyId: "zai" | "bigmodel" | null =
    familySpec && isZhipuModelProviderFamilyId(familySpec.id)
      ? (familySpec.id as Exclude<ModelProviderFamilyId, "kimi">)
      : null;
  const fingerprint = inspection
    ? JSON.stringify([provider?.accountState?.connectionKey ?? view?.revision, inspection])
    : "";
  return {
    enabled: Boolean(inspection && familyId),
    preferredProviderId: providerId,
    accountAccess: familyId
      ? { type: "zhipu-account", family: familyId, planKind: "start-plan" }
      : undefined,
    includeSubscription: true,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({ providerId, providerFingerprint: fingerprint }),
    refreshOnMount: false,
  };
}
