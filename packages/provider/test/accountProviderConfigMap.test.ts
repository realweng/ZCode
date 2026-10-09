import assert from "node:assert/strict";
import test from "node:test";
import { parseAccountProviderConfigMap } from "../src/config/schema.js";

// 回归：Host→CLI 的账号 Overlay 快照同时存在 zhipu 与 kimi 两类账号条目，
// schema 只认 zhipu-account 会导致整封配置被拒（kimi 登录后账号链路全灭）。
test("账号 Overlay 快照同时接受 zhipu-account 与 kimi-account 变体", () => {
  const map = parseAccountProviderConfigMap({
    "account:zai-individual-coding-plan": {
      access: { type: "zhipu-account", entitled: true },
    },
    "account:kimi-coding-plan": {
      access: { type: "kimi-account", entitled: true },
    },
    "account:kimi-global-coding-plan": {
      access: { type: "kimi-account", entitled: false },
    },
  });

  assert.equal(map.get("account:zai-individual-coding-plan")?.access?.type, "zhipu-account");
  assert.equal(map.get("account:kimi-coding-plan")?.access?.type, "kimi-account");
  assert.equal(map.get("account:kimi-coding-plan")?.access?.entitled, true);
  assert.equal(map.get("account:kimi-global-coding-plan")?.access?.entitled, false);
});
