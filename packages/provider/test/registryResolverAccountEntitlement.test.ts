import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  parseZCodeBuiltinModelConfigRules,
  parseZCodeBuiltinProviderConfigRules,
} from "../src/config/schema.js";
import {
  KimiAccountAccessConfig,
  ModelConfigRules,
  ProviderConfig,
  ProviderConfigMap,
} from "../src/config/index.js";
import { ProviderConfigResolver } from "../src/resolver.js";

// 回归：resolver 的 accessEntitled 门禁对非 zhipu 一律放行，导致 kimi 的 entitled:false
// 被忽略——未登录时 kimi 模型仍被发布为可执行，fail-closed 失效。
// 用真实内置配置驱动，避免测试与线上注册表分叉。
const builtinRelease = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../config/provider/zcode-builtin.json"), "utf8"),
);
const { providers: zcodeBuiltinProviders, providerTemplates: zcodeBuiltinProviderTemplates } =
  parseZCodeBuiltinProviderConfigRules(builtinRelease.config.providerConfigRules);
const zcodeBuiltinModelRules = parseZCodeBuiltinModelConfigRules(
  builtinRelease.config.modelConfigRules,
);

function resolveWithKimiEntitlement(entitled: boolean) {
  return new ProviderConfigResolver().resolve({
    zcodeBuiltinProviders,
    zcodeBuiltinProviderTemplates,
    personalProviders: new ProviderConfigMap([]),
    zcodeBuiltinModelRules,
    personalModels: ModelConfigRules.empty(),
    accountProviders: new ProviderConfigMap([
      [
        "account:kimi-coding-plan",
        new ProviderConfig({ access: new KimiAccountAccessConfig({ entitled }) }),
      ],
    ]),
  });
}

test("未授权 kimi 账号不发布可执行模型（fail-closed）", () => {
  const result = resolveWithKimiEntitlement(false);
  assert.equal(
    result.registryProviders.some((provider) => provider.providerId === "account:kimi-coding-plan"),
    false,
  );
});

test("已授权 kimi 账号发布可执行模型", () => {
  const result = resolveWithKimiEntitlement(true);
  assert.equal(
    result.registryProviders.some((provider) => provider.providerId === "account:kimi-coding-plan"),
    true,
  );
});
