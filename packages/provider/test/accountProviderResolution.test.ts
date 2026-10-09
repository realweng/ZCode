import assert from "node:assert/strict";
import test from "node:test";
import { resolveAccountProviderConfigs } from "../src/account-provider-resolution.js";
import {
  KimiAccountAccessConfig,
  ProviderConfig,
  ProviderConfigMap,
  ZhipuAccountAccessConfig,
} from "../src/config/index.js";

// 回归：builtin 注册表内置 account:kimi-* 提供方，连接解析产出 kimi 连接结果后，
// isAccountConstrainedProvider 只认 zhipu-account 会让 indexConnections 直接抛错，
// 整轮账号解析失败（首轮 fail-closed，之后只剩旧快照）。
test("kimi-account 连接结果被正确解析为权益 Overlay", () => {
  const configuredProviders = new ProviderConfigMap([
    [
      "account:kimi-coding-plan",
      new ProviderConfig({
        access: new KimiAccountAccessConfig({ accountType: "kimi", mode: "kimi-coding-plan" }),
      }),
    ],
  ]);

  const resolved = resolveAccountProviderConfigs({
    configuredProviders,
    previousProviders: new ProviderConfigMap([]),
    connections: [{ providerId: "account:kimi-coding-plan", status: "available" }],
  });

  const kimi = resolved.get("account:kimi-coding-plan");
  assert.equal(kimi?.access?.type, "kimi-account");
  assert.equal(kimi?.access?.entitled, true);
});

test("zhipu-account 连接结果行为保持不变", () => {
  const configuredProviders = new ProviderConfigMap([
    [
      "account:zai-individual-coding-plan",
      new ProviderConfig({
        access: new ZhipuAccountAccessConfig({
          accountType: "zai",
          mode: "individual-coding-plan",
        }),
      }),
    ],
  ]);

  // zhipu 侧回归保护：连接指向账号提供方时仍产出 Overlay 而不是抛错。
  const resolved = resolveAccountProviderConfigs({
    configuredProviders,
    previousProviders: new ProviderConfigMap([]),
    connections: [{ providerId: "account:zai-individual-coding-plan", status: "unavailable" }],
  });

  const zhipu = resolved.get("account:zai-individual-coding-plan");
  assert.equal(zhipu?.access?.type, "zhipu-account");
  assert.equal(zhipu?.access?.entitled, false);
});
