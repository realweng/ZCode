import assert from "node:assert/strict";
import test from "node:test";
import type { ApiClient } from "@zcode/shared";
import { KimiUsageQuotaProvider } from "../src/usage-stats/providers/kimiUsageQuotaProvider.js";

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
}

/** 按 URL 子串匹配路由并记录请求头；未命中返回 404。 */
function createRecordingApiClient(routes: Record<string, { status: number; body: unknown }>) {
  const requests: RecordedRequest[] = [];
  const apiClient: ApiClient = {
    request: async (input, init) => {
      const url = String(input);
      const headers = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k, v]),
      );
      requests.push({ url, headers });
      const key = Object.keys(routes).find((routeKey) => url.includes(routeKey));
      const route = key ? routes[key] : undefined;
      if (!route) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify(route.body), {
        status: route.status,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
  return { apiClient, requests };
}

function createFakeOAuthService(tokens: Record<string, { accessToken: string } | null>) {
  return {
    resolveFreshOAuthTokenSet: async (provider: string) => tokens[provider] ?? null,
  };
}

test("kimi 额度快照：/usages 映射为 5 小时窗口与周配额两条额度条", async () => {
  const { apiClient, requests } = createRecordingApiClient({
    "/coding/v1/usages": {
      status: 200,
      body: {
        usage: { limit: 100, used: 51, remaining: 49, resetTime: "2026-10-16T17:12:00Z" },
        limits: [{ limit: 100, used: 100, remaining: 0, resetTime: 1_760_000_000, limited: true }],
        parallel: { limit: 20 },
      },
    },
    "/coding/v1/me": {
      status: 200,
      body: { user_id: "u1", nickname: "n", membership_level: "LEVEL_INTERMEDIATE" },
    },
  });
  const provider = new KimiUsageQuotaProvider({
    apiClient,
    oauthService: createFakeOAuthService({ kimi: { accessToken: "k-at" } }),
    env: {},
  });

  const snapshot = await provider.getSnapshotForRequest({
    preferredProviderId: "account:kimi-coding-plan",
  });

  // Spike 实测：不带 User-Agent: KimiCLI/1.6 接口返回 404，必须硬编码携带。
  const usagesRequest = requests.find((request) => request.url.endsWith("/coding/v1/usages"));
  assert.ok(usagesRequest);
  assert.equal(usagesRequest.headers["User-Agent"], "KimiCLI/1.6");
  assert.equal(usagesRequest.headers["Authorization"], "Bearer k-at");

  assert.equal(snapshot.authenticated, true);
  assert.equal(snapshot.quota?.level, "LEVEL_INTERMEDIATE");
  const limits = snapshot.quota?.limits ?? [];
  assert.equal(limits.length, 2);

  const fiveHour = limits.find((limit) => limit.unit === 3 && limit.number === 5);
  assert.equal(fiveHour?.type, "TOKENS_LIMIT");
  assert.equal(fiveHour?.remaining, 0);
  assert.equal(fiveHour?.percentage, 100);
  // resetTime 秒级时间戳归一化为毫秒。
  assert.equal(fiveHour?.nextResetTime, 1_760_000_000 * 1000);

  const weekly = limits.find((limit) => limit.unit === 6 && limit.number === undefined);
  assert.equal(weekly?.type, "TOKENS_LIMIT");
  assert.equal(weekly?.remaining, 49);
  assert.equal(weekly?.percentage, 51);
  assert.equal(weekly?.nextResetTime, Date.parse("2026-10-16T17:12:00Z"));

  assert.equal(snapshot.remaining?.count, 0);
  assert.equal(snapshot.remaining?.percentage, 100);
  assert.equal(snapshot.context?.scope, "personal");
  assert.match(snapshot.context?.displayName ?? "", /Kimi Coding Plan/);
  assert.equal(snapshot.mcpQuota ?? null, null);
});

test("kimi 未登录：不发起请求并返回 not_configured", async () => {
  const { apiClient, requests } = createRecordingApiClient({});
  const provider = new KimiUsageQuotaProvider({
    apiClient,
    oauthService: createFakeOAuthService({}),
    env: {},
  });

  const snapshot = await provider.getSnapshotForRequest({
    preferredProviderId: "account:kimi-coding-plan",
  });

  assert.equal(requests.length, 0);
  assert.equal(snapshot.authenticated, false);
  assert.equal(snapshot.unavailableReason, "not_configured");
  assert.equal(snapshot.quota, null);
  assert.equal(snapshot.remaining, null);
});

test("kimi /usages 失败：抛错走统一失败退避，不发布伪成功空快照", async () => {
  const { apiClient } = createRecordingApiClient({
    "/coding/v1/usages": { status: 500, body: { error: "boom" } },
  });
  const provider = new KimiUsageQuotaProvider({
    apiClient,
    oauthService: createFakeOAuthService({ kimi: { accessToken: "k-at" } }),
    env: {},
  });

  await assert.rejects(() =>
    provider.getSnapshotForRequest({ preferredProviderId: "account:kimi-coding-plan" }),
  );
});

test("kimi-global 账号使用 api.kimi.ai origin 与 kimi-global 凭据", async () => {
  const { apiClient, requests } = createRecordingApiClient({
    "/coding/v1/usages": {
      status: 200,
      body: {
        usage: { limit: 10, used: 0, remaining: 10, resetTime: null },
        limits: [],
      },
    },
    "/coding/v1/me": { status: 200, body: { user_id: "u2", nickname: "g" } },
  });
  const provider = new KimiUsageQuotaProvider({
    apiClient,
    oauthService: createFakeOAuthService({ "kimi-global": { accessToken: "kg-at" } }),
    env: {},
  });

  const snapshot = await provider.getSnapshotForRequest({
    preferredProviderId: "account:kimi-global-coding-plan",
  });

  assert.equal(snapshot.authenticated, true);
  const usagesRequest = requests.find((request) => request.url.includes("/usages"));
  assert.ok(usagesRequest?.url.startsWith("https://api.kimi.ai/coding/v1/"));
  assert.equal(usagesRequest?.headers["Authorization"], "Bearer kg-at");
});
