import assert from "node:assert/strict";
import test from "node:test";
import type { ApiClient } from "@zcode/shared";
import { KimiProviderAdapter } from "../src/oauth/providers/kimiProviderAdapter.js";
import type { OAuthProviderRuntimeConfig } from "../src/oauth/runtimeConfig.js";

function createConfig(
  overrides: Partial<OAuthProviderRuntimeConfig> = {},
): OAuthProviderRuntimeConfig {
  return {
    id: "kimi",
    displayName: "Kimi",
    enabled: true,
    order: 2,
    authorizeUrl: "https://auth.kimi.com/api/oauth/device_authorization",
    tokenUrl: "https://auth.kimi.com/api/oauth/token",
    userinfoUrl: "https://api.kimi.com/coding/v1/me",
    appId: "test-client-id",
    redirectUri: "",
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createApiClient(
  handler: (input: string | URL, init?: { method?: string; body?: unknown }) => Response,
): ApiClient {
  return {
    request: async (input, init) => handler(input, init as { method?: string; body?: unknown }),
  };
}

const NOW = 1_800_000_000_000;

test("kimi adapter: startDeviceFlow 返回 deviceCode 与完整授权地址", async () => {
  let capturedBody = "";
  const apiClient = createApiClient((input, init) => {
    assert.equal(String(input), "https://auth.kimi.com/api/oauth/device_authorization");
    assert.equal(init?.method, "POST");
    capturedBody = String(init?.body ?? "");
    return jsonResponse(200, {
      device_code: "dc-123",
      user_code: "ABCD-EFGH",
      verification_uri: "https://auth.kimi.com/device",
      verification_uri_complete: "https://auth.kimi.com/device?user_code=ABCD-EFGH",
      expires_in: 900,
      interval: 5,
    });
  });

  const adapter = new KimiProviderAdapter(createConfig(), apiClient);
  const start = await adapter.startDeviceFlow({
    providerId: "kimi",
    state: "",
    redirectUri: "",
    now: () => NOW,
  });

  assert.equal(start.deviceCode, "dc-123");
  assert.equal(start.userCode, "ABCD-EFGH");
  assert.equal(start.verificationUriComplete, "https://auth.kimi.com/device?user_code=ABCD-EFGH");
  assert.equal(start.expiresAt, NOW + 900_000);
  assert.equal(start.pollIntervalMs, 5_000);
  assert.ok(capturedBody.includes("client_id=test-client-id"));
});

test("kimi adapter: pollDeviceToken 返回 pending / slow-down / token", async () => {
  let calls = 0;
  const apiClient = createApiClient(() => {
    calls += 1;
    if (calls === 1) {
      return jsonResponse(400, { error: "authorization_pending" });
    }
    if (calls === 2) {
      return jsonResponse(400, { error: "slow_down" });
    }
    return jsonResponse(200, {
      access_token: "at-1",
      refresh_token: "rt-1",
      expires_in: 3600,
      token_type: "Bearer",
    });
  });

  const adapter = new KimiProviderAdapter(createConfig(), apiClient);
  const context = {
    providerId: "kimi",
    state: "s",
    redirectUri: "",
    now: () => NOW,
  };

  assert.deepEqual(await adapter.pollDeviceToken("dc-1", context), {
    status: "pending",
  });
  const slowDown = await adapter.pollDeviceToken("dc-1", context);
  assert.equal(slowDown.status, "slow-down");
  if (slowDown.status === "slow-down") {
    assert.equal(slowDown.nextIntervalMs, 5_000);
  }
  const token = await adapter.pollDeviceToken("dc-1", context);
  assert.equal(token.status, "token");
  if (token.status === "token") {
    assert.equal(token.tokenSet.accessToken, "at-1");
    assert.equal(token.tokenSet.refreshToken, "rt-1");
    assert.equal(token.tokenSet.expiresAt, NOW + 3_600_000);
  }
});

test("kimi adapter: pollDeviceToken 的 expired/denied 归一化为终止态", async () => {
  for (const [errorCode, expected] of [
    ["expired_token", "expired"],
    ["access_denied", "denied"],
  ] as const) {
    const apiClient = createApiClient(() => jsonResponse(400, { error: errorCode }));
    const adapter = new KimiProviderAdapter(createConfig(), apiClient);
    const result = await adapter.pollDeviceToken("dc-1", {
      providerId: "kimi",
      state: "s",
      redirectUri: "",
      now: () => NOW,
    });
    assert.equal(result.status, expected);
  }
});

test("kimi adapter: refreshToken 轮换 refresh token，未下发时保留旧值", async () => {
  let capturedBody = "";
  const apiClient = createApiClient((_input, init) => {
    capturedBody = String(init?.body ?? "");
    return jsonResponse(200, {
      access_token: "at-new",
      expires_in: 7200,
      token_type: "Bearer",
    });
  });
  const adapter = new KimiProviderAdapter(createConfig(), apiClient);
  const refreshed = await adapter.refreshToken(
    { accessToken: "at-old", refreshToken: "rt-old" },
    { providerId: "kimi", state: "", redirectUri: "", now: () => NOW },
  );
  assert.equal(refreshed.accessToken, "at-new");
  // 服务端未轮换 refresh token 时必须保留旧值，避免清空唯一可用凭据。
  assert.equal(refreshed.refreshToken, "rt-old");
  assert.equal(refreshed.expiresAt, NOW + 7_200_000);
  assert.ok(capturedBody.includes("grant_type=refresh_token"));
  assert.ok(capturedBody.includes("refresh_token=rt-old"));
});

test("kimi adapter: fetchUserInfo 按 /me 的 snake_case 归一化", async () => {
  const apiClient = createApiClient((input, init) => {
    assert.equal(String(input), "https://api.kimi.com/coding/v1/me");
    const headers = (init as { headers?: Record<string, string> } | undefined)?.headers ?? {};
    assert.equal(headers.Authorization, "Bearer at-1");
    return jsonResponse(200, {
      user_id: "u-42",
      nickname: "测试用户",
      email: "u42@kimi.com",
      avatar: "https://cdn.kimi.com/avatar.png",
    });
  });
  const adapter = new KimiProviderAdapter(createConfig(), apiClient);
  const profile = await adapter.fetchUserInfo(
    { accessToken: "at-1" },
    { providerId: "kimi", state: "", redirectUri: "", now: () => NOW },
  );
  assert.equal(profile.id, "u-42");
  assert.equal(profile.username, "测试用户");
  assert.equal(profile.displayName, "测试用户");
  assert.equal(profile.avatarUrl, "https://cdn.kimi.com/avatar.png");
});
