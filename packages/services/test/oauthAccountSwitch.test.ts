import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ApiClient } from "@zcode/shared";
import { OAuthService } from "../src/oauth/oauthService.js";
import { createOAuthProviderLogoutHandler } from "../src/oauth/oauthProviderLogout.js";
import { OAuthCredentialRepo } from "../src/oauth/repo/oauthCredentialRepo.js";
import { createCredentialService } from "../src/credential/credentialService.js";
import { setDataBaseDir } from "../src/paths.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 仅覆盖 Kimi device flow 登录所需端点；一步成功。 */
function createKimiLoginApiClient(): ApiClient {
  return {
    request: async (input) => {
      const url = String(input);
      if (url.endsWith("/api/oauth/device_authorization")) {
        return jsonResponse(200, {
          device_code: "dc-switch",
          user_code: "CODE-1234",
          verification_uri: "https://auth.kimi.com/device",
          verification_uri_complete: "https://auth.kimi.com/device?user_code=CODE-1234",
          expires_in: 900,
          interval: 5,
        });
      }
      if (url.endsWith("/api/oauth/token")) {
        return jsonResponse(200, {
          access_token: "kimi-at",
          refresh_token: "kimi-rt",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      if (url.endsWith("/me")) {
        return jsonResponse(200, { user_id: "u-kimi", nickname: "Kimi 用户" });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  };
}

function createUnexpiredZcodeJwt(nowSeconds = 1_800_000_000): string {
  const segment = (value: unknown) =>
    JSON.stringify(value).replaceAll("+", "-").replaceAll("/", "_");
  // 仅本地恢复链路解析 exp，不做签名校验；payload 给未来时间即可。
  const payload = JSON.stringify({ exp: nowSeconds + 3_600 })
    .replaceAll("+", "-")
    .replaceAll("/", "_");
  return `${segment({ alg: "none", typ: "JWT" })}.${payload}.sig`;
}

async function createAccountSwitchHarness() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-oauth-switch-"));
  setDataBaseDir(dir);
  const credentialService = createCredentialService();
  const service = new OAuthService(credentialService, {
    apiClient: createKimiLoginApiClient(),
  });
  const repo = new OAuthCredentialRepo(credentialService, {
    providerIds: ["zai", "bigmodel", "kimi", "kimi-global"],
  });
  return {
    service,
    repo,
    credentialService,
    cleanup: async () => {
      service.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function loginKimi(service: OAuthService): Promise<void> {
  await service.startOAuthWithPolling("kimi");
  const result = await service.pollPendingOAuth();
  assert.equal(result?.kind, "session");
}

test("switchAccountFamily: 切回已持久化的智谱账号无需重新登录", async () => {
  const { service, repo, credentialService, cleanup } = await createAccountSwitchHarness();
  try {
    await loginKimi(service);
    // 跨 family 凭据共存是现状事实：预置智谱历史登录态。
    // zai 的展示恢复还要求共享 zcodejwttoken 存在（真实智谱登录会写入，跨 family 不清理）。
    await repo.saveTokenSet("zai", { accessToken: "zai-at", refreshToken: "zai-rt" });
    await repo.saveUserProfile("zai", {
      id: "u-zai",
      username: "zai-user",
      displayName: "智谱用户",
    });
    await credentialService.save("zcodejwttoken", createUnexpiredZcodeJwt());

    assert.equal(await service.getActiveProvider(), "kimi");
    const result = await service.switchAccountFamily("zai");
    assert.deepEqual(result, { kind: "switched", provider: "zai" });
    assert.equal(await service.getActiveProvider(), "zai");

    // 切换后展示态按新 active provider 恢复（复用既有 restore 链路，不做远端校验）。
    const restored = await service.restoreCachedSession();
    assert.equal(restored?.id, "u-zai");
    assert.equal(restored?.displayName, "智谱用户");
  } finally {
    await cleanup();
  }
});

test("switchAccountFamily: 目标无凭据时返回 login-required 且不改 active", async () => {
  const { service, cleanup } = await createAccountSwitchHarness();
  try {
    await loginKimi(service);

    const result = await service.switchAccountFamily("bigmodel");
    assert.deepEqual(result, { kind: "login-required", provider: "bigmodel" });
    assert.equal(await service.getActiveProvider(), "kimi");
  } finally {
    await cleanup();
  }
});

test("switchAccountFamily: 反向从智谱切回 kimi 同样生效", async () => {
  const { service, repo, cleanup } = await createAccountSwitchHarness();
  try {
    await loginKimi(service);
    await repo.saveTokenSet("zai", { accessToken: "zai-at" });
    await repo.saveUserProfile("zai", {
      id: "u-zai",
      username: "zai-user",
      displayName: "智谱用户",
    });
    await repo.setActiveProvider("zai");

    const result = await service.switchAccountFamily("kimi");
    assert.deepEqual(result, { kind: "switched", provider: "kimi" });
    assert.equal(await service.getActiveProvider(), "kimi");
    assert.equal((await service.restoreCachedSession())?.id, "u-kimi");
  } finally {
    await cleanup();
  }
});

test("listPersistedOAuthProviders: 仅返回有持久化档案的 provider", async () => {
  const { service, repo, cleanup } = await createAccountSwitchHarness();
  try {
    await loginKimi(service);
    await repo.saveUserProfile("zai", {
      id: "u-zai",
      username: "zai-user",
      displayName: "智谱用户",
    });

    const persisted = await service.listPersistedOAuthProviders();
    assert.deepEqual([...persisted].sort(), ["kimi", "zai"]);
  } finally {
    await cleanup();
  }
});

test("oauthProviderLogout: kimi 登出也触发账号 provider 刷新", async () => {
  const refreshReasons: string[] = [];
  const handler = createOAuthProviderLogoutHandler({
    accountProviderCredentialStore: { deleteApiKey: async () => {} },
    refreshAccountProviders: async (reason) => {
      refreshReasons.push(reason);
    },
  });

  await handler("kimi");
  // Bug 根因：kimi 在 resolveProviderIds 返回 null 后提前 return，
  // refreshAccountProviders 不触发，账号列表残留已登出状态。
  assert.deepEqual(refreshReasons, ["oauth-logout:kimi"]);
});
