import { z } from "zod";
import type {
  ApiClient,
  OAuthTokenSet,
  UsageEntitlementRequest,
  UsageEntitlementSnapshot,
  UsageQuotaLimit,
} from "@zcode/shared";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { readApiJson } from "../../providers/api/apiJson.js";
import { readEnv } from "../../oauth/providers/configUtils.js";

/**
 * Kimi Coding Plan 用量查询。
 *
 * 非公开接口（无官方文档）：额度在 `GET {origin}/coding/v1/usages`，鉴权复用本机
 * OAuth access token（与模型请求同一 Bearer）。接口方硬性要求 User-Agent 为
 * KimiCLI 前缀，缺失会返回 404（Spike 实测）。响应字段无公开契约，解析容忍未知键，
 * resetTime 防御性处理秒/毫秒/ISO 三种形态。
 */

// Spike 实测：不带该 UA 调用 /usages 一律 404。
const KIMI_USAGE_USER_AGENT = "KimiCLI/1.6";
const log = createServiceLogger("usage-stats");

type KimiOAuthProviderId = "kimi" | "kimi-global";

interface KimiProviderMeta {
  readonly oauthId: KimiOAuthProviderId;
  readonly defaultOrigin: string;
  readonly originEnvKey: string;
  readonly label: string;
}

const KIMI_PROVIDER_META: Readonly<Record<string, KimiProviderMeta>> = {
  [BUILTIN_MODEL_PROVIDER_IDS.kimiCodingPlan]: {
    oauthId: "kimi",
    defaultOrigin: "https://api.kimi.com",
    originEnvKey: "ZCODE_KIMI_CODING_API_ORIGIN",
    label: "Kimi Coding Plan",
  },
  [BUILTIN_MODEL_PROVIDER_IDS.kimiGlobalCodingPlan]: {
    oauthId: "kimi-global",
    defaultOrigin: "https://api.kimi.ai",
    originEnvKey: "ZCODE_KIMI_GLOBAL_CODING_API_ORIGIN",
    label: "Kimi Coding Plan",
  },
};

export function resolveKimiUsagesUrl(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const meta = KIMI_PROVIDER_META[providerId];
  if (!meta) {
    throw new Error(`KimiUsageQuotaProvider 不支持的 provider: ${providerId}`);
  }
  return `${readEnv(env, meta.originEnvKey) ?? meta.defaultOrigin}/coding/v1/usages`;
}

/**
 * Kimi 用量查询的 token 来源。resolveFreshOAuthTokenSet 只存在于 OAuthService 类上
 * （不在 IOAuthService 接口里），这里用结构化类型收窄到 Kimi 两个 provider。
 */
export interface KimiOAuthTokenSource {
  resolveFreshOAuthTokenSet(provider: "kimi" | "kimi-global"): Promise<OAuthTokenSet | null>;
}

const kimiUsageBucketSchema = z
  .object({
    limit: z.number().finite(),
    used: z.number().finite(),
    remaining: z.number().finite().nullable().optional(),
    resetTime: z.unknown().optional(),
    limited: z.boolean().optional(),
  })
  .passthrough();
const kimiUsagesResponseSchema = z
  .object({
    usage: kimiUsageBucketSchema.optional(),
    limits: z.array(kimiUsageBucketSchema).optional(),
    parallel: z.object({ limit: z.number().optional() }).passthrough().optional(),
  })
  .passthrough();
type KimiUsageBucket = z.infer<typeof kimiUsageBucketSchema>;

export interface KimiUsageQuotaProviderOptions {
  readonly apiClient: ApiClient;
  readonly oauthService: KimiOAuthTokenSource;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}

export class KimiUsageQuotaProvider {
  private readonly apiClient: ApiClient;
  private readonly oauthService: KimiUsageQuotaProviderOptions["oauthService"];
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;

  constructor(options: KimiUsageQuotaProviderOptions) {
    this.apiClient = options.apiClient;
    this.oauthService = options.oauthService;
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
  }

  async getSnapshotForRequest(
    request: UsageEntitlementRequest = {},
  ): Promise<UsageEntitlementSnapshot> {
    const providerId = request.preferredProviderId?.trim() ?? "";
    const meta = KIMI_PROVIDER_META[providerId];
    if (!meta) {
      throw new Error(`KimiUsageQuotaProvider 不支持的 provider: ${providerId || "(empty)"}`);
    }

    const generatedAt = this.now();
    const tokenSet: OAuthTokenSet | null = await this.oauthService.resolveFreshOAuthTokenSet(
      meta.oauthId,
    );
    const accessToken = tokenSet?.accessToken?.trim() ?? "";
    if (!accessToken) {
      return {
        generatedAt,
        authenticated: false,
        unavailableReason: "not_configured",
        provider: null,
        remaining: null,
        subscription: null,
        quota: null,
      };
    }

    const origin = readEnv(this.env, meta.originEnvKey) ?? meta.defaultOrigin;
    const authorization = `Bearer ${accessToken}`;
    const [usagesBody, level] = await Promise.all([
      readApiJson<unknown>(this.apiClient, `${origin}/coding/v1/usages`, {
        headers: { Authorization: authorization, "User-Agent": KIMI_USAGE_USER_AGENT },
      }).then((body) => kimiUsagesResponseSchema.parse(body)),
      this.fetchMembershipLevel(origin, authorization),
    ]);

    const windowLimits = (usagesBody.limits ?? []).map((bucket) => toQuotaLimit(bucket, 3, 5));
    const weeklyLimit = usagesBody.usage ? toQuotaLimit(usagesBody.usage, 6) : null;
    const limits: UsageQuotaLimit[] = [...windowLimits, ...(weeklyLimit ? [weeklyLimit] : [])];
    const primaryLimit = windowLimits[0] ?? weeklyLimit;

    return {
      generatedAt,
      authenticated: true,
      context: {
        scope: "personal",
        displayName: level ? `${meta.label} · ${level}` : meta.label,
      },
      provider: { id: providerId, name: meta.label },
      remaining: primaryLimit
        ? {
            count: primaryLimit.remaining ?? 0,
            isShow: true,
            percentage: primaryLimit.percentage,
            nextResetTime: primaryLimit.nextResetTime ?? null,
          }
        : null,
      subscription: null,
      quota: { level: level ?? null, limits },
    };
  }

  /** 会员等级仅作额度卡标签；失败不阻塞额度快照。 */
  private async fetchMembershipLevel(
    origin: string,
    authorization: string,
  ): Promise<string | null> {
    try {
      const body = await readApiJson<unknown>(this.apiClient, `${origin}/coding/v1/me`, {
        headers: { Authorization: authorization, "User-Agent": KIMI_USAGE_USER_AGENT },
      });
      return extractMembershipLevel(body);
    } catch (error) {
      log.debug("Kimi 会员等级读取失败，额度卡按无 level 展示", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

function toQuotaLimit(bucket: KimiUsageBucket, unit: number, number?: number): UsageQuotaLimit {
  const limit = bucket.limit;
  const used = bucket.used;
  const remaining = bucket.remaining ?? Math.max(limit - used, 0);
  // percentage 沿用 quota 接口口径：已使用占比，展示端负责反转成剩余。
  const percentage = limit > 0 ? Math.round((used / limit) * 1000) / 10 : 0;
  const nextResetTime = normalizeResetTime(bucket.resetTime);
  return {
    type: "TOKENS_LIMIT",
    ...(number === undefined ? {} : { number }),
    unit,
    usage: used,
    currentValue: used,
    remaining,
    percentage,
    ...(nextResetTime === null ? {} : { nextResetTime }),
    usageDetails: [],
  };
}

/** 非公开接口的时间字段形态不稳定：秒级 epoch、毫秒 epoch、ISO 字符串都出现过。 */
function normalizeResetTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? Math.round(value) : Math.round(value * 1000);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractMembershipLevel(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  for (const key of [
    "membership_level",
    "membershipLevel",
    "level",
    "plan_level",
    "planLevel",
    "member_level",
    "memberLevel",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}
