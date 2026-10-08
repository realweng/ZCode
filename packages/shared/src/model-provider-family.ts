import {
  BIGMODEL_PROVIDER_ID,
  KIMI_GLOBAL_PROVIDER_ID,
  KIMI_PROVIDER_ID,
  type OAuthProviderId,
  ZAI_PROVIDER_ID,
} from "./oauth.js";
import { BUILTIN_MODEL_PROVIDER_IDS, type BuiltinModelProviderId } from "./model-provider-types.js";
import { ZCODE_ENV } from "./env.js";
import { buildBigModelCodingPlanTeamManageUrl } from "./zcodeEndpoint.js";

export type ModelProviderFamilyId = "zai" | "bigmodel" | "kimi";
export type ProviderFamilyDomain = ModelProviderFamilyId;

export interface ModelProviderFamilySpec {
  id: ModelProviderFamilyId;
  label: string;
  rootDomain: string;
  /** 同一 family 的额外根域（如 Kimi 的 kimi.ai Global 域）。 */
  additionalRootDomains?: readonly string[];
  oauthProviderId: OAuthProviderId;
  startPlanProviderId: BuiltinModelProviderId;
  individualCodingPlanProviderId: BuiltinModelProviderId;
  teamCodingPlanProviderId: BuiltinModelProviderId;
  teamCodingPlanManageUrl: string;
}

export const MODEL_PROVIDER_FAMILY_SPECS = [
  {
    id: "zai",
    label: "Z.ai",
    rootDomain: "z.ai",
    oauthProviderId: ZAI_PROVIDER_ID,
    startPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
    individualCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    teamCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
    teamCodingPlanManageUrl: "https://z.ai/manage-apikey/subscription",
  },
  {
    id: "bigmodel",
    label: "BigModel",
    rootDomain: "bigmodel.cn",
    oauthProviderId: BIGMODEL_PROVIDER_ID,
    startPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    individualCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    teamCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
    teamCodingPlanManageUrl: buildBigModelCodingPlanTeamManageUrl({ ZCODE_ENV }),
  },
  {
    // Kimi 没有 Start/Team 商品形态，三个商品槽都指向唯一 的 coding plan provider，
    // 保证 family 反查（provider id → family）与既有 UI 消费方不用增加空值分支。
    id: "kimi",
    label: "Kimi",
    rootDomain: "kimi.com",
    additionalRootDomains: ["kimi.ai"],
    oauthProviderId: KIMI_PROVIDER_ID,
    startPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.kimiCodingPlan,
    individualCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.kimiCodingPlan,
    teamCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.kimiCodingPlan,
    teamCodingPlanManageUrl: "https://platform.kimi.com",
  },
] as const satisfies readonly ModelProviderFamilySpec[];

const MODEL_PROVIDER_FAMILY_SPEC_BY_ID = new Map<ModelProviderFamilyId, ModelProviderFamilySpec>(
  MODEL_PROVIDER_FAMILY_SPECS.map((spec) => [spec.id, spec]),
);

const MODEL_PROVIDER_FAMILY_ID_BY_PROVIDER_ID = new Map<
  BuiltinModelProviderId,
  ModelProviderFamilyId
>(
  MODEL_PROVIDER_FAMILY_SPECS.flatMap((spec) =>
    [
      spec.startPlanProviderId,
      spec.individualCodingPlanProviderId,
      spec.teamCodingPlanProviderId,
    ].map((providerId) => [providerId, spec.id] as const),
  ),
);

export function getModelProviderFamilySpec(
  familyId: ModelProviderFamilyId,
): ModelProviderFamilySpec {
  return MODEL_PROVIDER_FAMILY_SPEC_BY_ID.get(familyId)!;
}

export function resolveModelProviderFamilyIdByProviderId(
  providerId: string,
): ModelProviderFamilyId | null {
  return MODEL_PROVIDER_FAMILY_ID_BY_PROVIDER_ID.get(providerId as BuiltinModelProviderId) ?? null;
}

export function resolveModelProviderFamilyIdByBaseURL(
  baseURL: string | null | undefined,
): ModelProviderFamilyId | null {
  const trimmed = baseURL?.trim();
  if (!trimmed) {
    return null;
  }
  let hostname: string;
  try {
    hostname = new URL(trimmed).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const entry of MODEL_PROVIDER_FAMILY_SPECS) {
    // satisfies 保留字面量联合，这里收宽到 spec 类型统一读取可选根域。
    const spec: ModelProviderFamilySpec = entry;
    const familyDomains = [spec.rootDomain, ...(spec.additionalRootDomains ?? [])];
    if (familyDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
      return spec.id;
    }
  }
  return null;
}

/** zhipu 账号域 family（zai/bigmodel）；Kimi 是独立账号域，不能构造 zhipu-account access。 */
export function isZhipuModelProviderFamilyId(
  familyId: ModelProviderFamilyId,
): familyId is "zai" | "bigmodel" {
  return familyId === "zai" || familyId === "bigmodel";
}

export function resolveModelProviderFamilySpecByProviderId(
  providerId: string,
): ModelProviderFamilySpec | null {
  const familyId = resolveModelProviderFamilyIdByProviderId(providerId);
  return familyId ? getModelProviderFamilySpec(familyId) : null;
}

export function resolveModelProviderFamilyLabelByProviderId(providerId: string): string | null {
  return resolveModelProviderFamilySpecByProviderId(providerId)?.label ?? null;
}

export function normalizeProviderFamilyDomain(
  value: string | null | undefined,
): ProviderFamilyDomain | null {
  return value === "zai" || value === "bigmodel" || value === "kimi" ? value : null;
}

export function resolveProviderFamilyDomainFromOAuthProvider(
  provider: OAuthProviderId | string | null | undefined,
): ProviderFamilyDomain | null {
  if (provider === ZAI_PROVIDER_ID) {
    return "zai";
  }
  if (provider === BIGMODEL_PROVIDER_ID) {
    return "bigmodel";
  }
  // Kimi 两个区域共享一个 family，登录任一区域都归入 kimi 展示域。
  if (provider === KIMI_PROVIDER_ID || provider === KIMI_GLOBAL_PROVIDER_ID) {
    return "kimi";
  }
  return null;
}

export function shouldShowModelProviderFamilyForDomain(params: {
  familyId: ModelProviderFamilyId;
  providerFamilyDomain: ProviderFamilyDomain | null | undefined;
}): boolean {
  const providerFamilyDomain = normalizeProviderFamilyDomain(params.providerFamilyDomain);
  if (!providerFamilyDomain) {
    return true;
  }
  return params.familyId === providerFamilyDomain;
}

export function shouldShowModelProviderFamilyForActiveOAuth(params: {
  familyId: ModelProviderFamilyId;
  activeOAuthProvider: OAuthProviderId | null | undefined;
}): boolean {
  return shouldShowModelProviderFamilyForDomain({
    familyId: params.familyId,
    providerFamilyDomain: resolveProviderFamilyDomainFromOAuthProvider(params.activeOAuthProvider),
  });
}

export function shouldShowBuiltinModelProviderForDomain(params: {
  providerId: string;
  providerFamilyDomain: ProviderFamilyDomain | null | undefined;
}): boolean {
  const familyId = resolveModelProviderFamilyIdByProviderId(params.providerId);
  if (!familyId) {
    return true;
  }
  return shouldShowModelProviderFamilyForDomain({
    familyId,
    providerFamilyDomain: params.providerFamilyDomain,
  });
}

export function shouldShowBuiltinModelProviderForActiveOAuth(params: {
  providerId: string;
  activeOAuthProvider: OAuthProviderId | null | undefined;
}): boolean {
  return shouldShowBuiltinModelProviderForDomain({
    providerId: params.providerId,
    providerFamilyDomain: resolveProviderFamilyDomainFromOAuthProvider(params.activeOAuthProvider),
  });
}
