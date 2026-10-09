import type {
  ApiClient,
  AppUsageRequest,
  AppUsageSnapshot,
  CodingPlanUsageRequest,
  CodingPlanUsageSnapshot,
  CodingPlanResetOpportunityRequest,
  CodingPlanResetOpportunityResult,
  CodingPlanResetScopeRequest,
  CodingPlanResetStatusSnapshot,
  CodingPlanResetUseRequest,
  CodingPlanResetUseResult,
  UsageEntitlementRequest,
  UsageEntitlementSnapshot,
  UsageStatsRequest,
  UsageStatsSnapshot,
} from "@zcode/shared";
import { isCodingPlanModelProviderId, isKimiCodingPlanProviderId } from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { IAccountRequestAuthService } from "../model-provider/accountRequestAuthService.js";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { IUsageStatsService } from "./usageStats.js";
import {
  BigModelUsageQuotaProvider,
  type UsageApiAuthorizationRequest,
  type UsageApiAuthorization,
} from "./providers/bigmodelUsageQuotaProvider.js";
import {
  KimiUsageQuotaProvider,
  type KimiOAuthTokenSource,
} from "./providers/kimiUsageQuotaProvider.js";
import type { OfficialMcpCredentialSource } from "./providers/zcodeMcpQuotaProvider.js";

interface UsageStatsServiceDependencies {
  apiClient: ApiClient;
  accountRequestAuthService: Pick<
    IAccountRequestAuthService,
    "resolveAccessCurrent" | "resolveCurrent" | "assertCurrent"
  >;
  resolveApiAuthorization?: (
    request: UsageApiAuthorizationRequest,
  ) => Promise<UsageApiAuthorization | null>;
  credentialService?: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
  /** App Usage 经 ZCode Protocol 读取 agent 数据库真实统计。 */
  zcodeAgentService: Pick<IZCodeAgentService, "getAppUsageStats">;
  /**
   * 官方 Server MCP 额度的凭证来源（与 server MCP 调用同一套 5 个身份头）。
   * 缺省时 entitlement 快照不含 MCP 额度。
   */
  officialMcpCredentialSource?: OfficialMcpCredentialSource;
  /** Kimi Coding Plan 用量的 OAuth token 来源；缺省时 kimi 路由不可用并回退原行为。 */
  oauthService?: KimiOAuthTokenSource;
}

function isCodingPlanProviderId(providerId: string | undefined): boolean {
  return Boolean(providerId && isCodingPlanModelProviderId(providerId));
}

function assertResetSupportedProviderId(providerId: string | undefined): void {
  if (providerId && isKimiCodingPlanProviderId(providerId)) {
    // Kimi 无额度重置接口（reset 系列是智谱 monitor 专有）；isCodingPlanModelProviderId
    // 白名单包含 kimi，缺这道守卫会把 kimi 的 reset 请求误打到 BigModel 域名。
    throw new Error("kimi_coding_plan_reset_not_supported");
  }
}

export function createUsageStatsService(
  dependencies: UsageStatsServiceDependencies,
): IUsageStatsService {
  const quotaProvider = new BigModelUsageQuotaProvider({
    apiClient: dependencies.apiClient,
    accountRequestAuthService: dependencies.accountRequestAuthService,
    resolveApiAuthorization: dependencies.resolveApiAuthorization,
    credentialService: dependencies.credentialService,
    env: dependencies.env,
    ...(dependencies.officialMcpCredentialSource
      ? { officialMcpCredentialSource: dependencies.officialMcpCredentialSource }
      : {}),
  });
  const kimiQuotaProvider = dependencies.oauthService
    ? new KimiUsageQuotaProvider({
        apiClient: dependencies.apiClient,
        oauthService: dependencies.oauthService,
        env: dependencies.env,
      })
    : null;

  return {
    async getAppUsageSnapshot(request: AppUsageRequest): Promise<AppUsageSnapshot> {
      // App Usage 现读取 agent 数据库真实统计（model_usage/turn_usage/tool_usage），
      // 经 ZCode Protocol usage/stats 取回。不再读本地 session JSON 估算。
      return dependencies.zcodeAgentService.getAppUsageStats({
        range: request.range,
        timeZone: request.timeZone,
      });
    },
    async getCodingPlanUsageSnapshot(
      request: CodingPlanUsageRequest,
    ): Promise<CodingPlanUsageSnapshot> {
      assertResetSupportedProviderId(request.preferredProviderId);
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        // Coding Plan 页面只允许预置的 Z.AI/BigModel Coding Plan 账号。
        // 普通 provider id 不能进入 monitor 链路，避免误读 API Key 或环境变量。
        throw new Error("no_bigmodel_api_key");
      }
      return quotaProvider.getCodingPlanUsageSnapshot(request);
    },
    async getCodingPlanResetStatus(
      request: CodingPlanResetScopeRequest,
    ): Promise<CodingPlanResetStatusSnapshot> {
      assertResetSupportedProviderId(request.preferredProviderId);
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        throw new Error("no_bigmodel_api_key");
      }
      return quotaProvider.getCodingPlanResetStatus(request);
    },
    async requestCodingPlanResetOpportunity(
      request: CodingPlanResetOpportunityRequest,
    ): Promise<CodingPlanResetOpportunityResult> {
      assertResetSupportedProviderId(request.preferredProviderId);
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        throw new Error("no_bigmodel_api_key");
      }
      return quotaProvider.requestCodingPlanResetOpportunity(request);
    },
    async useCodingPlanReset(
      request: CodingPlanResetUseRequest,
    ): Promise<CodingPlanResetUseResult> {
      assertResetSupportedProviderId(request.preferredProviderId);
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        throw new Error("no_bigmodel_api_key");
      }
      return quotaProvider.useCodingPlanReset(request);
    },
    async markCodingPlanResetHistoryRead(request: CodingPlanResetScopeRequest): Promise<void> {
      assertResetSupportedProviderId(request.preferredProviderId);
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        throw new Error("no_bigmodel_api_key");
      }
      await quotaProvider.markCodingPlanResetHistoryRead(request);
    },
    async getSnapshot(request: UsageStatsRequest): Promise<UsageStatsSnapshot> {
      // App Usage 已迁移到 getAppUsageSnapshot（agent 数据库）。getSnapshot 仅服务 Coding Plan monitor 链路。
      // 任何 monitor 失败都不能回退本地数据，保持数据源隔离。
      return quotaProvider.getUsageStatsSnapshot(request);
    },
    async getEntitlementSnapshot(
      request: UsageEntitlementRequest = {},
    ): Promise<UsageEntitlementSnapshot> {
      // Kimi 额度走独立 provider（OAuth token + /coding/v1/usages），不进入智谱 monitor 链路。
      if (
        request.preferredProviderId &&
        isKimiCodingPlanProviderId(request.preferredProviderId) &&
        kimiQuotaProvider
      ) {
        return kimiQuotaProvider.getSnapshotForRequest(request);
      }
      return quotaProvider.getSnapshotForRequest(request);
    },
  };
}
