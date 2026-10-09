import {
  BUILTIN_MODEL_PROVIDER_IDS,
  getModelProviderFamilySpec,
  isKimiCodingPlanProviderId,
  isZhipuModelProviderFamilyId,
  normalizeProviderFamilyDomain,
  resolveModelProviderFamilySpecByProviderId,
  type ProviderFamilyConnectionSelectionSettings,
  type ProviderFamilyDomain,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
import {
  resolveEnterpriseCodingPlanProductFamily,
  type EnterpriseCodingPlanProductDisplay,
} from "@/settings/model-provider-section/enterpriseCodingPlanProducts.js";
import type {
  SidebarUsageCodingPlanProviderId,
  SidebarUsageCodingPlanSourceId,
} from "@/lib/sidebarUsageCodingPlanProviderPreference.js";
import { formatTeamPlanDisplayName } from "@/lib/teamPlanDisplayName.js";

/**
 * Kimi 来源可用的两个区域 provider。
 * kimi 与 kimi-global 同属一个 family，但各自持有独立 OAuth 凭据，必须逐 provider 表达。
 */
export type KimiCodingPlanUsageProviderId =
  | typeof BUILTIN_MODEL_PROVIDER_IDS.kimiCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.kimiGlobalCodingPlan;

export interface CodingPlanUsageSource {
  id: SidebarUsageCodingPlanSourceId;
  providerId: SidebarUsageCodingPlanProviderId;
  label: string;
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
}

export function buildPersonalCodingPlanUsageSource({
  providerId,
  accountAccess,
  label,
}: {
  providerId: SidebarUsageCodingPlanProviderId;
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  label?: string | null;
}): CodingPlanUsageSource {
  const normalizedLabel = label?.trim();
  return {
    id: providerId,
    providerId,
    accountAccess,
    label:
      normalizedLabel ||
      (providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
        ? "Z.ai - Coding Plan"
        : isKimiCodingPlanProviderId(providerId)
          ? "Kimi - Coding Plan"
          : "BigModel - Coding Plan"),
  };
}

/**
 * Kimi 个人套餐来源的可见条件。
 *
 * Kimi 是独立账号域（单活语义），只在当前展示域是 kimi 时展示。登出会把
 * providerFamilyDomain 清空，此时若该用户此前选择过 kimi 连接方式
 * （providerFamilyConnectionSelections.kimi 仍在），继续保留入口以展示 not_configured，
 * 而不是让页面看起来像从未接入过 Kimi。
 */
export function shouldOfferKimiCodingPlanUsageSource(params: {
  providerFamilyDomain: ProviderFamilyDomain | null | undefined;
  connectionSelections?: ProviderFamilyConnectionSelectionSettings | null;
}): boolean {
  const providerFamilyDomain = normalizeProviderFamilyDomain(params.providerFamilyDomain);
  if (providerFamilyDomain === "kimi") {
    return true;
  }
  if (providerFamilyDomain !== null) {
    return false;
  }
  return params.connectionSelections?.kimi != null;
}

/**
 * 解析 Kimi 来源要使用的 providerId。
 *
 * kimi 与 kimi-global 是同一 family 的两个区域，各自持有独立 OAuth 凭据；
 * 当前选中的模型 provider 优先，缺失时按账号区域回退。
 */
export function resolveKimiCodingPlanUsageProviderId(params: {
  selectedProviderId?: string | null;
  accountType?: ZCodeProviderAccountAccess["accountType"] | null;
}): KimiCodingPlanUsageProviderId {
  const selectedProviderId = params.selectedProviderId?.trim() ?? "";
  if (isKimiCodingPlanProviderId(selectedProviderId)) {
    return selectedProviderId as KimiCodingPlanUsageProviderId;
  }
  return params.accountType === "kimi-global"
    ? BUILTIN_MODEL_PROVIDER_IDS.kimiGlobalCodingPlan
    : BUILTIN_MODEL_PROVIDER_IDS.kimiCodingPlan;
}

type CurrentSidebarCodingPlanUsageSource =
  | {
      audience: "individual";
      providerId: SidebarUsageCodingPlanProviderId;
      sourceId: SidebarUsageCodingPlanSourceId;
      accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
      teamSource?: never;
    }
  | {
      audience: "team";
      // 原硬绑 bigmodelCodingPlan，zai team plan 的 currentUsageSource
      // 无法表达 zai providerId。松开为 SidebarUsageCodingPlanProviderId，
      // zai/bigmodel team 都按各自 selectedKey 解析出的 providerId 表达。
      providerId: SidebarUsageCodingPlanProviderId;
      sourceId: SidebarUsageCodingPlanSourceId;
      teamSource: CodingPlanUsageSource;
    };

export function buildCodingPlanUsageSources({
  accountAccesses,
  subscribedTeamProducts,
}: {
  accountAccesses: Partial<Record<ProviderFamilyDomain, ZCodeProviderAccountAccess>>;
  subscribedTeamProducts: EnterpriseCodingPlanProductDisplay[];
}): CodingPlanUsageSource[] {
  return buildTeamCodingPlanUsageSources(subscribedTeamProducts, accountAccesses);
}

function buildTeamCodingPlanUsageSources(
  subscribedTeamProducts: EnterpriseCodingPlanProductDisplay[],
  accountAccesses: Partial<Record<ProviderFamilyDomain, ZCodeProviderAccountAccess>>,
): CodingPlanUsageSource[] {
  const seen = new Set<string>();
  return subscribedTeamProducts.flatMap((product) => {
    const projectContexts =
      product.teamProjects && product.teamProjects.length > 0
        ? product.teamProjects
        : [
            {
              organizationId: product.organizationId ?? null,
              organizationName: product.organizationName ?? null,
              projectId: product.projectId ?? null,
              projectName: product.projectName ?? null,
            },
          ];

    return projectContexts.flatMap((projectContext, index) => {
      const organizationId = projectContext.organizationId?.trim() ?? "";
      const projectId = projectContext.projectId?.trim() ?? "";
      if (!organizationId || !projectId) {
        return [];
      }
      const label = formatTeamUsageSourceLabel({
        product,
        organizationId,
        organizationName: projectContext.organizationName ?? product.organizationName,
        projectId,
        projectName: projectContext.projectName ?? product.projectName,
      });
      if (!label) {
        // Team Plan usage source 只展示组织名；缺失时不能生成 "BigModel - " 空白来源。
        return [];
      }
      const projectKey = projectId || String(index);
      // 原 createBigModelTeamPlanConnectionKey + bigmodelCodingPlan providerId
      // 硬编码 bigmodel，zai team product 的 sourceId 用了 bigmodel 前缀、providerId 也错。
      // 按 product.family 用 family-aware key + 对应 codingPlan providerId。
      const productFamily = resolveEnterpriseCodingPlanProductFamily(product);
      // Kimi 没有 Team 商品，sidebar 用量源只存在于 zhipu 域 family。
      if (!isZhipuModelProviderFamilyId(productFamily)) {
        return [];
      }
      const baseAccess = accountAccesses[productFamily];
      if (baseAccess?.mode !== "team-coding-plan") {
        return [];
      }
      const codingPlanProviderId = getModelProviderFamilySpec(productFamily)
        .teamCodingPlanProviderId as SidebarUsageCodingPlanProviderId;
      const sourceId = ["team", productFamily, product.productId, organizationId, projectKey]
        .map(encodeURIComponent)
        .join(":") as SidebarUsageCodingPlanSourceId;
      if (seen.has(sourceId)) {
        return [];
      }
      seen.add(sourceId);
      return [
        {
          id: sourceId,
          providerId: codingPlanProviderId,
          accountAccess: {
            type: "zhipu-account",
            family: productFamily,
            planKind: "team-coding-plan",
            productId: product.productId,
            organizationId,
            projectId,
          },
          label,
        },
      ];
    });
  });
}

export function resolveSidebarCurrentCodingPlanUsageSource({
  selections,
  selectedProviderId,
  accountAccesses,
  teamSources,
}: {
  selections?: ProviderFamilyConnectionSelectionSettings | null;
  selectedProviderId: string | null;
  accountAccesses: Partial<Record<ProviderFamilyDomain, ZCodeProviderAccountAccess>>;
  teamSources: CodingPlanUsageSource[];
}): CurrentSidebarCodingPlanUsageSource | null {
  // Kimi Global（account:kimi-global-coding-plan）不在 shared 的 provider→family 反查表里
  // （该表由 family spec 的三个商品槽构造，kimi 三个槽都指向 kimi-coding-plan）。
  // 只依赖反查会让 kimi-global 账号的 sidebar 来源永远解析为 null，因此先按 kimi provider 判定。
  const kimiSelectedProviderId = selectedProviderId?.trim() ?? "";
  const selectedIsKimiCodingPlan = isKimiCodingPlanProviderId(kimiSelectedProviderId);
  const family = selectedIsKimiCodingPlan
    ? "kimi"
    : kimiSelectedProviderId
      ? resolveModelProviderFamilySpecByProviderId(kimiSelectedProviderId)?.id
      : undefined;
  if (!family) return null;
  // Kimi 没有商品选择层与订阅快照通道，来源直接由账号区域决定：
  // 当前选中的模型 provider 已是 kimi 域，access 存在即代表可查询（未登录由服务端返回 not_configured）。
  if (family === "kimi") {
    const kimiAccountAccess = accountAccesses.kimi;
    if (!kimiAccountAccess || kimiAccountAccess.type !== "kimi-account") return null;
    const providerId = resolveKimiCodingPlanUsageProviderId({
      selectedProviderId: kimiSelectedProviderId,
      accountType: kimiAccountAccess.accountType,
    });
    return {
      audience: "individual",
      providerId,
      sourceId: providerId,
      accountAccess: kimiAccountAccess,
    };
  }
  const selection = selections?.[family];
  if (selection?.kind === "team-coding-plan") {
    const teamSource = teamSources.find(
      (source) =>
        "planKind" in source.accountAccess &&
        source.accountAccess.planKind === "team-coding-plan" &&
        source.accountAccess.family === family &&
        source.accountAccess.productId === selection.productId &&
        source.accountAccess.organizationId === selection.organizationId &&
        source.accountAccess.projectId === selection.projectId,
    );
    return teamSource
      ? {
          audience: "team",
          providerId: teamSource.providerId,
          sourceId: teamSource.id,
          teamSource,
        }
      : null;
  }
  if (selection?.kind !== "individual-coding-plan") return null;
  const accountAccess = accountAccesses[family];
  if (!accountAccess || accountAccess.mode !== "individual-coding-plan") return null;
  const providerId = getModelProviderFamilySpec(family)
    .individualCodingPlanProviderId as SidebarUsageCodingPlanProviderId;
  return { audience: "individual", providerId, sourceId: providerId, accountAccess };
}

function formatTeamUsageSourceLabel({
  product,
  organizationId,
  organizationName,
  projectId,
  projectName,
}: {
  product: EnterpriseCodingPlanProductDisplay;
  organizationId?: string | null;
  organizationName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
}): string | null {
  const teamPlanName = formatTeamPlanDisplayName({
    ...product,
    organizationId,
    organizationName,
    projectId,
    projectName,
  });
  if (!teamPlanName) {
    return null;
  }
  // 原硬编码 "BigModel - " 前缀，zai team source 显示出来品牌也错位。
  // 按 product.family 取品牌前缀，与 codingPlanItem.providerName 对齐。
  const brandPrefix = `${getModelProviderFamilySpec(resolveEnterpriseCodingPlanProductFamily(product)).label} - `;
  return `${brandPrefix}${teamPlanName}`;
}
