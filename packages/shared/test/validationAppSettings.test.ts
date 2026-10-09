import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

// 回归：Kimi OAuth 登录成功后会写 providerFamilyDomain="kimi"；
// 枚举缺 kimi 时 setProviderFamilyDomain 抛 ZodError（登录回调判失败），
// 且磁盘已存 "kimi" 时完整设置 safeParse 失败会被静默回退为默认设置。
test("设置 patch 接受 providerFamilyDomain=kimi", () => {
  const parsed = appSettingsPatchSchema.safeParse({ providerFamilyDomain: "kimi" });
  assert.equal(parsed.success, true);
});

test("完整设置 schema 接受持久化的 providerFamilyDomain=kimi", () => {
  const parsed = appSettingsSchema.safeParse({ providerFamilyDomain: "kimi" });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.providerFamilyDomain, "kimi");
  }
});
