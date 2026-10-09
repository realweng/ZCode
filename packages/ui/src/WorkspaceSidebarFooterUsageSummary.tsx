import { useCodingPlanEntryGate } from "@/settings/CodingPlanEntryButton.js";
/* eslint-disable max-lines -- footer 套餐徽标、升级入口与 entitlement 探测共用同一份
   provider 选择与 family 过滤上下文，拆文件会让 zai/bigmodel 对称性难以追踪。 */
import { useEffect, useMemo } from "react";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  normalizeProviderFamilyDomain,
  resolveModelProviderFamilyIdByProviderId,
  TID_SIDEBAR_CODING_PLAN_USAGE_BUTTON,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
import { BarChart3Icon, RocketIcon } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu.js";
import {
  resolveCodingPlanUsageRemainingState,
  type CodingPlanUsageAvailableProvider,
} from "@/CodingPlanUsageRemainingPanel.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useUsageEntitlement } from "@/hooks/useUsageEntitlement.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useSettings } from "@/hooks/useSettingService.js";
import {
  resolveEntitledAccountProviderAccess,
  resolveEntitledAccountProviderAccessFingerprint,
  resolveKimiAccountProviderAccess,
} from "@/lib/accountProviderAccess.js";
import { buildUsageEntitlementCacheKey } from "@/lib/usageEntitlementCache.js";
import {
  isMaxCodingPlanSnapshot,
  resolveSidebarCodingPlanUpgradeFallbackProviderId,
} from "@/lib/sidebarCodingPlanUpgrade.js";
import {
  createCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanState,
  type CodingPlanFunnelContext,
} from "@/lib/codingPlanFunnelTelemetry.js";
import { type SidebarUsageCodingPlanProviderId } from "@/lib/sidebarUsageCodingPlanProviderPreference.js";
import { useEnterpriseCodingPlanProducts } from "@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js";
import {
  buildCodingPlanUsageSources,
  resolveSidebarCurrentCodingPlanUsageSource,
} from "@/lib/codingPlanUsageSources.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { parseCustomProviderIdFromSupplierKey } from "@/lib/modelConfigSync.js";
import { setPendingSettingsUsageIntent } from "@/lib/settingsNavigation.js";
import {
  resolveSidebarFooterPlanBadgeLabel,
  resolveSidebarFooterProfilePlanBadge,
} from "@/WorkspaceSidebarFooterPlanBadgeHelpers.js";

export {
  resolveSidebarFooterPlanBadgeLabel,
  resolveSidebarFooterProfilePlanBadge,
} from "@/WorkspaceSidebarFooterPlanBadgeHelpers.js";

const TID_SIDEBAR_CODING_PLAN_UPGRADE_BUTTON = "sidebar-coding-plan-upgrade-button";

/**
 * Kimi 来源的 provider 条目。
 * `CodingPlanUsageAvailableProvider` 的 accountAccess 是 zhipu/kimi 的宽联合，
 * 这里收窄到 Provider 级 access，才能直接读 `entitled` 判断区域登录态。
 */
interface KimiCodingPlanUsageProvider extends CodingPlanUsageAvailableProvider {
  accountAccess: ZCodeProviderAccountAccess;
}

export function WorkspaceSidebarFooterUsageSummary({
  enabled,
  onUsageClick,
  onUpgradeClick,
  workspaceIdentity,
  workspacePath,
}: {
  enabled: boolean;
  onUsageClick?: () => void;
  onUpgradeClick?: (
    providerId: SidebarUsageCodingPlanProviderId,
    funnelContext: CodingPlanFunnelContext,
  ) => void;
  workspaceIdentity?: string;
  workspacePath?: string;
}) {
  const state = useWorkspaceSidebarFooterUsageSummaryState({
    enabled,
    workspaceIdentity,
    workspacePath,
  });
  return (
    <WorkspaceSidebarFooterUsageSummaryContent
      state={state}
      onUsageClick={onUsageClick}
      onUpgradeClick={onUpgradeClick}
    />
  );
}

export function useWorkspaceSidebarFooterUsageSummaryState({
  enabled,
  workspaceIdentity,
  workspacePath,
}: {
  enabled: boolean;
  workspaceIdentity?: string;
  workspacePath?: string;
}) {
  const { settings: sharedSettings } = useSettings();
  const providerFamilyDomain = normalizeProviderFamilyDomain(sharedSettings?.providerFamilyDomain);
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  // 首次读取失败也不能被解释成“已经加载且没有套餐”；只有 Ready 才能消费 Provider 事实。
  const providerSourcesLoading = providerSettingsRead.state.status !== "ready";
  const selectedSupplierKey = useZCodeSessionStore((state) =>
    workspacePath
      ? selectWorkspaceZCodeState(state, workspacePath, workspaceIdentity).selectedSupplierKey
      : "",
  );
  const selectedProviderIdFromSupplierKey =
    parseCustomProviderIdFromSupplierKey(selectedSupplierKey);
  const selectedProviderFamilyId = selectedProviderIdFromSupplierKey
    ? resolveModelProviderFamilyIdByProviderId(selectedProviderIdFromSupplierKey)
    : null;
  // providerFamilyDomain 是当前登录/运行 family 边界；BigModel Team selectedKey
  // 会在切换到 Z.ai 后保留，footer 若不按当前 domain 过滤会把头像旁徽标误显示成 Team。
  const scopedSelectedProviderId =
    selectedProviderFamilyId &&
    providerFamilyDomain &&
    selectedProviderFamilyId !== providerFamilyDomain
      ? null
      : selectedProviderIdFromSupplierKey;
  const zhipuCodingPlanProviders = useMemo(
    () =>
      [
        BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      ].flatMap((providerId): CodingPlanUsageAvailableProvider[] => {
        const access = resolveEntitledAccountProviderAccess(providerSettingsView, providerId);
        if (!access) return [];
        return [
          {
            providerId,
            accountAccess: access.access,
            label:
              access.label ||
              (providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
                ? "Z.ai - Coding Plan"
                : "BigModel - Coding Plan"),
          },
        ];
      }),
    [providerSettingsView],
  );
  // Kimi 是独立账号域（单活语义）：只有当前展示域是 kimi 时才把它的来源接入 footer，
  // 避免 zhipu 域出现另一个账号域的额度。
  const kimiCodingPlanProviders = useMemo(
    () =>
      providerFamilyDomain === "kimi"
        ? [
            BUILTIN_MODEL_PROVIDER_IDS.kimiCodingPlan,
            BUILTIN_MODEL_PROVIDER_IDS.kimiGlobalCodingPlan,
          ].flatMap((providerId): KimiCodingPlanUsageProvider[] => {
            const access = resolveKimiAccountProviderAccess(providerSettingsView, providerId);
            if (!access) return [];
            return [
              {
                providerId,
                accountAccess: access.access,
                label: access.label || "Kimi - Coding Plan",
              },
            ];
          })
        : [],
    [providerFamilyDomain, providerSettingsView],
  );
  // 两个区域各持独立 OAuth 凭据：当前选中的模型 provider 优先，其次取已登录区域。
  const activeKimiCodingPlanProvider =
    kimiCodingPlanProviders.find((provider) => provider.providerId === scopedSelectedProviderId) ??
    kimiCodingPlanProviders.find((provider) => provider.accountAccess.entitled === true) ??
    kimiCodingPlanProviders[0];
  const availableCodingPlanProviders = useMemo(
    () => [
      ...zhipuCodingPlanProviders,
      ...(activeKimiCodingPlanProvider ? [activeKimiCodingPlanProvider] : []),
    ],
    [activeKimiCodingPlanProvider, zhipuCodingPlanProviders],
  );
  const zaiProvider = zhipuCodingPlanProviders.find(
    (provider) => provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
  );
  const bigmodelProvider = zhipuCodingPlanProviders.find(
    (provider) => provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  );
  const zaiProviderFingerprint = resolveEntitledAccountProviderAccessFingerprint(
    providerSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
  );
  const bigmodelProviderFingerprint = resolveEntitledAccountProviderAccessFingerprint(
    providerSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  );
  const zaiTeamProvider = resolveEntitledAccountProviderAccess(
    providerSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
  );
  const bigmodelTeamProvider = resolveEntitledAccountProviderAccess(
    providerSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
  );
  const bigmodelFamilyAllowed = providerFamilyDomain !== "zai";
  // 原只有 bigmodelFamilyAllowed 单变量，zai family 下 enterprise products 完全不拉。
  // zai team plan 对称化需要 zai family 也独立拉一份 enterprise pricing。
  const zaiFamilyAllowed = providerFamilyDomain !== "bigmodel";
  const bigmodelEnterpriseProducts = useEnterpriseCodingPlanProducts({
    // footer badge 和升级入口都需要识别 Team Plan。
    // Team 项目上下文只在企业 pricing/customerInfo 返回，账号级头像徽标也不能被当前连接方式卡住。
    enabled:
      enabled && !providerSourcesLoading && bigmodelFamilyAllowed && Boolean(bigmodelTeamProvider),
    authenticated: true,
    family: "bigmodel",
  });
  const zaiEnterpriseProducts = useEnterpriseCodingPlanProducts({
    enabled: enabled && !providerSourcesLoading && zaiFamilyAllowed && Boolean(zaiTeamProvider),
    authenticated: true,
    family: "zai",
  });
  const subscribedTeamProducts = useMemo(
    () => [
      ...(bigmodelEnterpriseProducts.snapshot?.productList.filter(
        (product) => product.subscribed === true,
      ) ?? []),
      ...(zaiEnterpriseProducts.snapshot?.productList.filter(
        (product) => product.subscribed === true,
      ) ?? []),
    ],
    [bigmodelEnterpriseProducts.snapshot?.productList, zaiEnterpriseProducts.snapshot?.productList],
  );
  const teamSources = useMemo(
    () =>
      buildCodingPlanUsageSources({
        accountAccesses: {
          ...(zaiTeamProvider?.access
            ? {
                zai: zaiTeamProvider.access,
              }
            : {}),
          ...(bigmodelTeamProvider?.access
            ? {
                bigmodel: bigmodelTeamProvider.access,
              }
            : {}),
        },
        subscribedTeamProducts,
      }),
    [bigmodelTeamProvider?.access, subscribedTeamProducts, zaiTeamProvider?.access],
  );
  const currentUsageSource = useMemo(
    () =>
      resolveSidebarCurrentCodingPlanUsageSource({
        selections: sharedSettings?.providerFamilyConnectionSelections,
        selectedProviderId: scopedSelectedProviderId,
        accountAccesses: {
          ...(resolveEntitledAccountProviderAccess(
            providerSettingsView,
            BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
          )?.access
            ? {
                zai: resolveEntitledAccountProviderAccess(
                  providerSettingsView,
                  BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
                )!.access,
              }
            : {}),
          ...(resolveEntitledAccountProviderAccess(
            providerSettingsView,
            BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          )?.access
            ? {
                bigmodel: resolveEntitledAccountProviderAccess(
                  providerSettingsView,
                  BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
                )!.access,
              }
            : {}),
          ...(activeKimiCodingPlanProvider
            ? {
                kimi: activeKimiCodingPlanProvider.accountAccess,
              }
            : {}),
        },
        teamSources,
      }),
    [
      scopedSelectedProviderId,
      activeKimiCodingPlanProvider,
      bigmodelProvider?.accountAccess,
      sharedSettings?.providerFamilyConnectionSelections,
      teamSources,
      zaiProvider?.accountAccess,
    ],
  );
  const selectedProviderId = currentUsageSource?.sourceId;

  const zaiEntitlement = useUsageEntitlement({
    enabled:
      enabled &&
      !providerSourcesLoading &&
      providerFamilyDomain !== "bigmodel" &&
      Boolean(zaiProvider),
    includeSubscription: true,
    preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    accountAccess: resolveEntitledAccountProviderAccess(
      providerSettingsView,
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    )?.access,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      providerFingerprint: zaiProviderFingerprint,
    }),
    refreshOnMount: false,
  });
  const bigmodelEntitlement = useUsageEntitlement({
    enabled:
      enabled && !providerSourcesLoading && bigmodelFamilyAllowed && Boolean(bigmodelProvider),
    includeSubscription: true,
    preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountAccess: resolveEntitledAccountProviderAccess(
      providerSettingsView,
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    )?.access,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      providerFingerprint: bigmodelProviderFingerprint,
    }),
    refreshOnMount: false,
  });
  const teamEntitlement = useUsageEntitlement({
    // 原硬绑 bigmodelCodingPlan providerId 判断，zai team source 的 providerId
    // 是 zaiCodingPlan，永远进不到 team 分支，导致 zai team 额度不查询、badge 不显示。
    // 改为按 currentUsageSource.audience === "team" 路由，providerId 动态取。
    enabled: enabled && !providerSourcesLoading && currentUsageSource?.audience === "team",
    includeSubscription: true,
    preferredProviderId:
      currentUsageSource?.providerId ?? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountAccess: currentUsageSource?.teamSource?.accountAccess,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: currentUsageSource?.teamSource?.id,
    refreshOnMount: false,
  });
  const kimiEntitlement = useUsageEntitlement({
    // Kimi 无订阅摘要（subscription 恒为 null），只取额度与会员等级；
    // 未登录时服务端返回 not_configured，banner 按同态样式提示。
    enabled: enabled && !providerSourcesLoading && Boolean(activeKimiCodingPlanProvider),
    includeSubscription: false,
    preferredProviderId: activeKimiCodingPlanProvider?.providerId,
    accountAccess: activeKimiCodingPlanProvider?.accountAccess,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: activeKimiCodingPlanProvider
      ? buildUsageEntitlementCacheKey({
          providerId: activeKimiCodingPlanProvider.providerId,
          providerFingerprint: JSON.stringify([
            providerSettingsView?.revision,
            activeKimiCodingPlanProvider.providerId,
            activeKimiCodingPlanProvider.accountAccess,
          ]),
        })
      : "",
    refreshOnMount: false,
  });
  // footer 是常驻入口，refreshOnMount: false 后冷启动没有其它
  // 入口预热 entitlement，个人计划徽标缺失。可见时触发一次 access 刷新，复用共享
  // 1 分钟 freshness window、失败退避和 in-flight 合并；hook disabled 时 refresh 是 no-op。
  useEffect(() => {
    for (const refresh of [
      zaiEntitlement.refresh,
      bigmodelEntitlement.refresh,
      teamEntitlement.refresh,
      kimiEntitlement.refresh,
    ]) {
      void refresh({ silent: true, reason: "access" });
    }
  }, [
    zaiEntitlement.refresh,
    bigmodelEntitlement.refresh,
    teamEntitlement.refresh,
    kimiEntitlement.refresh,
  ]);
  const profilePlanBadge = resolveSidebarFooterProfilePlanBadge({
    individualEntitlements: [
      ...(providerFamilyDomain !== "bigmodel"
        ? [
            {
              providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
              snapshot: zaiEntitlement.snapshot,
              loading: zaiEntitlement.loading,
            },
          ]
        : []),
      ...(bigmodelFamilyAllowed
        ? [
            {
              providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
              snapshot: bigmodelEntitlement.snapshot,
              loading: bigmodelEntitlement.loading,
            },
          ]
        : []),
    ],
    // 头像徽标使用账号的 Team entitlement；pricing 结果只负责额度来源和套餐详情。
    hasTeamPlanEntitlement:
      providerFamilyDomain === "zai"
        ? Boolean(zaiTeamProvider)
        : providerFamilyDomain === "bigmodel"
          ? Boolean(bigmodelTeamProvider)
          : Boolean(zaiTeamProvider || bigmodelTeamProvider),
  });
  const providerEntitlements = [
    ...(currentUsageSource?.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan &&
    currentUsageSource.audience === "individual"
      ? [
          {
            sourceId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
            providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
            accountAccess: currentUsageSource.accountAccess,
            ...zaiEntitlement,
          },
        ]
      : []),
    ...(currentUsageSource?.providerId ===
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan &&
    currentUsageSource.audience === "individual"
      ? [
          {
            sourceId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
            providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
            accountAccess: currentUsageSource.accountAccess,
            ...bigmodelEntitlement,
          },
        ]
      : []),
    // 原 team 分支硬判 bigmodelCodingPlan providerId，zai team source 走不进来。
    // 改为统一按 audience === "team" 路由，覆盖 zai/bigmodel 两种 family 的 team source。
    ...(currentUsageSource?.audience === "team" && currentUsageSource.teamSource
      ? [
          {
            sourceId: currentUsageSource.teamSource.id,
            providerId: currentUsageSource.teamSource.providerId,
            accountAccess: currentUsageSource.teamSource.accountAccess,
            label: currentUsageSource.teamSource.label,
            ...teamEntitlement,
          },
        ]
      : []),
    // Kimi 没有 team source，额度来源直接绑定当前区域的 provider；
    // 未登录时 snapshot 为 not_configured，banner 不把它算作有套餐。
    ...(activeKimiCodingPlanProvider
      ? [
          {
            sourceId: activeKimiCodingPlanProvider.providerId,
            providerId: activeKimiCodingPlanProvider.providerId,
            accountAccess: activeKimiCodingPlanProvider.accountAccess,
            label: activeKimiCodingPlanProvider.label,
            ...kimiEntitlement,
          },
        ]
      : []),
  ];
  const usageState = resolveCodingPlanUsageRemainingState({
    availableProviders: availableCodingPlanProviders,
    entitlements: providerEntitlements,
    modelProvidersLoading: providerSourcesLoading,
    selectedProviderId,
  });
  const visibleUsageState = usageState?.hasAnyActiveCodingPlan ? usageState : null;
  // 升级/续期只覆盖智谱商品：Kimi 没有对应购买链路，kimi providerId 落到弹窗会打开空商品页。
  const resolveZhipuUpgradeProviderId = (
    providerId: string | undefined,
  ): SidebarUsageCodingPlanProviderId | undefined =>
    providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
      ? providerId
      : undefined;
  const selectedUpgradeProviderId = resolveZhipuUpgradeProviderId(selectedProviderId);
  const upgradeTargetProviderId =
    selectedUpgradeProviderId ??
    resolveZhipuUpgradeProviderId(currentUsageSource?.providerId) ??
    zhipuCodingPlanProviders[0]?.providerId ??
    resolveSidebarCodingPlanUpgradeFallbackProviderId(providerFamilyDomain);
  return {
    audience: currentUsageSource?.audience,
    availableCodingPlanProviders,
    providerSourcesLoading,
    providerEntitlements,
    profilePlanBadge,
    selectedProviderId,
    upgradeTargetProviderId,
    usageState: visibleUsageState,
  };
}

type WorkspaceSidebarFooterUsageSummaryState = ReturnType<
  typeof useWorkspaceSidebarFooterUsageSummaryState
>;

export function WorkspaceSidebarFooterUsageSummaryContent({
  state,
  onUsageClick,
  onUpgradeClick,
}: {
  state: WorkspaceSidebarFooterUsageSummaryState;
  onUsageClick?: () => void;
  onUpgradeClick?: (
    providerId: SidebarUsageCodingPlanProviderId,
    funnelContext: CodingPlanFunnelContext,
  ) => void;
}) {
  const { intl } = useZCodeIntl();
  const entryGate = useCodingPlanEntryGate();
  const { providerEntitlements, upgradeTargetProviderId } = state;
  const upgradeProviderSnapshot =
    providerEntitlements.find((item) => item.providerId === upgradeTargetProviderId)?.snapshot ??
    null;
  const upgradeActionLabelId = isMaxCodingPlanSnapshot(upgradeProviderSnapshot)
    ? "sidebar.usage.plan.renew"
    : "sidebar.usage.plan.upgrade";

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        data-testid={TID_SIDEBAR_CODING_PLAN_USAGE_BUTTON}
        onSelect={() => {
          setPendingSettingsUsageIntent();
          onUsageClick?.();
        }}
      >
        <BarChart3Icon className="size-4" />
        {intl.formatMessage({ id: "sidebar.usage.plan.openStats" })}
      </DropdownMenuItem>
      {/* 产品要求：升级入口始终显示；未解析出当前套餐时由当前 provider family 决定品牌。 */}
      <DropdownMenuItem
        data-testid={TID_SIDEBAR_CODING_PLAN_UPGRADE_BUTTON}
        disabled={entryGate.status === "loading"}
        aria-busy={entryGate.status === "loading"}
        onSelect={() => {
          if (entryGate.status !== "ready") {
            entryGate.retry?.();
            return;
          }
          onUpgradeClick?.(
            upgradeTargetProviderId,
            createCodingPlanFunnelContext({
              providerId: upgradeTargetProviderId,
              upgradeSource: "profile_menu",
              eventRegion: "app.profile",
              eventText: intl.formatMessage({ id: upgradeActionLabelId }),
              entryPlanState: resolveCodingPlanEntryPlanState({
                snapshot: upgradeProviderSnapshot,
              }),
            }),
          );
        }}
      >
        <RocketIcon className="size-4" />
        {entryGate.label ?? intl.formatMessage({ id: upgradeActionLabelId })}
      </DropdownMenuItem>
    </>
  );
}

export function WorkspaceSidebarFooterPlanBadge({
  state,
}: {
  state: WorkspaceSidebarFooterUsageSummaryState;
}) {
  const { intl } = useZCodeIntl();
  const label =
    state.profilePlanBadge?.audience === "team"
      ? intl.formatMessage({ id: "sidebar.usage.plan.audienceTeam" })
      : resolveSidebarFooterPlanBadgeLabel(state.profilePlanBadge?.snapshot ?? null);
  if (!label) {
    return null;
  }

  return (
    <span
      className="min-w-0 max-w-20 shrink truncate rounded-full border border-border bg-surface px-1 py-px text-ui-xs font-medium leading-normal text-foreground-subtle"
      title={label}
    >
      {label}
    </span>
  );
}
