import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ApiClient } from "@zcode/shared";
import { OAuthService } from "../src/oauth/oauthService.js";
import { createCredentialService } from "../src/credential/credentialService.js";
import { setDataBaseDir } from "../src/paths.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface DeviceFlowScriptStep {
  status: number;
  body: unknown;
}

/** 按脚本顺序应答 token 端点；device_authorization 固定成功。 */
function createScriptedApiClient(steps: DeviceFlowScriptStep[]): ApiClient {
  let tokenCalls = 0;
  return {
    request: async (input) => {
      const url = String(input);
      if (url.endsWith("/api/oauth/device_authorization")) {
        return jsonResponse(200, {
          device_code: "dc-script",
          user_code: "CODE-1234",
          verification_uri: "https://auth.kimi.com/device",
          verification_uri_complete: "https://auth.kimi.com/device?user_code=CODE-1234",
          expires_in: 900,
          interval: 5,
        });
      }
      if (url.endsWith("/api/oauth/token")) {
        const step = steps[Math.min(tokenCalls, steps.length - 1)];
        tokenCalls += 1;
        return jsonResponse(step.status, step.body);
      }
      if (url.endsWith("/me")) {
        return jsonResponse(200, { user_id: "u-script", nickname: "脚本用户" });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  };
}

/** 可推进的时钟：跳过轮询节流，避免测试按真实 5s 间隔等待。 */
function createManualClock(start = 1_800_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advanceMs: (ms: number) => {
      now += ms;
    },
  };
}

async function createOAuthServiceHarness(steps: DeviceFlowScriptStep[]) {
  const dir = await mkdtemp(join(tmpdir(), "zcode-oauth-device-"));
  setDataBaseDir(dir);
  const credentialService = createCredentialService();
  const apiClient = createScriptedApiClient(steps);
  const clock = createManualClock();
  const service = new OAuthService(credentialService, {
    apiClient,
    now: clock.now,
  });
  return {
    service,
    clock,
    cleanup: async () => {
      // OAuthService 的 pending 超时是 5 分钟真实定时器；测试必须显式 dispose，
      // 否则 node:test 进程会因未清理的 handle 挂起。
      service.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("oauthService device flow: pending → token 成功落盘并返回会话", async () => {
  const { service, clock, cleanup } = await createOAuthServiceHarness([
    { status: 400, body: { error: "authorization_pending" } },
    {
      status: 200,
      body: {
        access_token: "at-final",
        refresh_token: "rt-final",
        expires_in: 3600,
        token_type: "Bearer",
      },
    },
  ]);
  try {
    const start = await service.startOAuthWithPolling("kimi");
    assert.equal(start.provider, "kimi");
    assert.equal(start.authorizeUrl, "https://auth.kimi.com/device?user_code=CODE-1234");

    // 第一次轮询：pending，不产生结果。
    assert.equal(await service.pollPendingOAuth(), null);

    clock.advanceMs(6_000);
    const result = await service.pollPendingOAuth();
    assert.equal(result?.kind, "session");
    if (result?.kind === "session") {
      assert.equal(result.provider, "kimi");
      assert.equal(result.userInfo.id, "u-script");
      assert.equal(result.userInfo.displayName, "脚本用户");
    }

    // 会话落盘后可恢复。
    const restored = await service.restoreCachedSession();
    assert.equal(restored?.id, "u-script");
  } finally {
    await cleanup();
  }
});

test("oauthService device flow: slow_down 后继续轮询直至成功", async () => {
  const { service, clock, cleanup } = await createOAuthServiceHarness([
    { status: 400, body: { error: "slow_down" } },
    { status: 400, body: { error: "authorization_pending" } },
    { status: 200, body: { access_token: "at-ok", token_type: "Bearer" } },
  ]);
  try {
    await service.startOAuthWithPolling("kimi");
    assert.equal(await service.pollPendingOAuth(), null);
    // slow_down 后间隔变为 5s+5s。
    clock.advanceMs(10_500);
    assert.equal(await service.pollPendingOAuth(), null);
    clock.advanceMs(10_500);
    const result = await service.pollPendingOAuth();
    assert.equal(result?.kind, "session");
  } finally {
    await cleanup();
  }
});

test("oauthService device flow: access_denied 终止 flow 并报错", async () => {
  const { service, cleanup } = await createOAuthServiceHarness([
    { status: 400, body: { error: "access_denied" } },
  ]);
  try {
    await service.startOAuthWithPolling("kimi");
    await assert.rejects(() => service.pollPendingOAuth(), /授权被拒绝/);
    // 终止后再次轮询返回 null（flow 已收口）。
    assert.equal(await service.pollPendingOAuth(), null);
  } finally {
    await cleanup();
  }
});

test("oauthService device flow: expired_token 终止 flow 并报错", async () => {
  const { service, cleanup } = await createOAuthServiceHarness([
    { status: 400, body: { error: "expired_token" } },
  ]);
  try {
    await service.startOAuthWithPolling("kimi");
    await assert.rejects(() => service.pollPendingOAuth(), /已过期/);
    assert.equal(await service.pollPendingOAuth(), null);
  } finally {
    await cleanup();
  }
});
