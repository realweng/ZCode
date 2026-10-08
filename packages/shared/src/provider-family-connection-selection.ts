import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

export const providerFamilyConnectionSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start-plan") }).strict(),
  z.object({ kind: z.literal("individual-coding-plan") }).strict(),
  z
    .object({
      kind: z.literal("team-coding-plan"),
      productId: nonEmptyString,
      organizationId: nonEmptyString,
      projectId: nonEmptyString,
    })
    .strict(),
]);

export const providerFamilyConnectionSelectionSettingsSchema = z
  .object({
    zai: providerFamilyConnectionSelectionSchema.optional(),
    bigmodel: providerFamilyConnectionSelectionSchema.optional(),
    // Kimi 只有 coding plan 一种商品形态，选择恒为 individual-coding-plan；
    // 出现在 schema 中是为了让 family 索引类型覆盖 kimi 展示域。
    kimi: providerFamilyConnectionSelectionSchema.optional(),
  })
  .partial();

/** 用户对一个 Provider Family 的连接选择意图；不包含账号身份或动态凭据。 */
export type ProviderFamilyConnectionSelection = Readonly<
  z.infer<typeof providerFamilyConnectionSelectionSchema>
>;

export type ProviderFamilyConnectionSelectionSettings = z.infer<
  typeof providerFamilyConnectionSelectionSettingsSchema
>;
