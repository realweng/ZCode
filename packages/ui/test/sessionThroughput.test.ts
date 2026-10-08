import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTokensPerSecond,
  resolveLatestTokensPerSecond,
} from "../src/hooks/useSessionThroughput.js";
import {
  MAX_STREAMING_TOKEN_JUMP,
  advanceStreamingThroughputState,
  createStreamingThroughputState,
  estimateIncrementalTokens,
  estimateStreamingTokens,
  resolveStreamingTokensPerSecond,
} from "../src/v4/conversationStreamingThroughput.js";
import type { SessionDebugSnapshot } from "@zcode/shared";

function round(overrides: Partial<SessionDebugSnapshot["rounds"][number]>) {
  return {
    eventKey: "event-1",
    requestId: "request-1",
    requestIndex: 1,
    recordedAt: 1,
    usage: { inputTokens: 10, outputTokens: 100 },
    hitRate: null,
    generationDurationMs: 1000,
    tokensPerSecond: 100,
    ...overrides,
  } satisfies SessionDebugSnapshot["rounds"][number];
}

test("resolveLatestTokensPerSecond 只取末条 round，不回退旧值", () => {
  assert.equal(resolveLatestTokensPerSecond([]), null);
  assert.equal(resolveLatestTokensPerSecond([round({})]), 100);
  assert.equal(
    resolveLatestTokensPerSecond([
      round({ eventKey: "event-1", requestId: "request-1", tokensPerSecond: 100 }),
      round({ eventKey: "event-2", requestId: "request-2", tokensPerSecond: 42.5 }),
    ]),
    42.5,
  );
});

test("末条吞吐未知时保持缺席而不是冒充旧事实", () => {
  assert.equal(
    resolveLatestTokensPerSecond([
      round({ eventKey: "event-1", requestId: "request-1", tokensPerSecond: 100 }),
      round({
        eventKey: "event-2",
        requestId: "request-2",
        tokensPerSecond: null,
        generationDurationMs: null,
      }),
    ]),
    null,
  );
});

test("formatTokensPerSecond 与开发者面板 TPS 同格式：一位小数", () => {
  assert.equal(formatTokensPerSecond("en-US", 42.5), "42.5");
  assert.equal(formatTokensPerSecond("en-US", 100), "100");
  assert.equal(formatTokensPerSecond("en-US", 7.25), "7.3");
});

test("estimateStreamingTokens 与 CLI estimateTokens 同公式：中文双权重 ÷ 3", () => {
  // 6 个英文字符 → 2 token。
  assert.equal(estimateStreamingTokens("abcdef"), 2);
  // 3 个中文字符 → 3×2/3 = 2 token。
  assert.equal(estimateStreamingTokens("思考中"), 2);
  // 空文本不产生负数或 NaN。
  assert.equal(estimateStreamingTokens(""), 0);
});

test("estimateIncrementalTokens 只累加新增后缀，前缀改写时全文重算", () => {
  const first = estimateIncrementalTokens(null, "abcdef");
  assert.equal(first.tokens, 2);
  const grown = estimateIncrementalTokens(first, "abcdef" + "ghijkl");
  assert.equal(grown.tokens, 4);
  // 前缀被改写（投影重建）→ 退回全文重算，不沿用旧累计。
  const rebuilt = estimateIncrementalTokens(grown, "xyz");
  assert.equal(rebuilt.tokens, 1);
});

test("累计平均：突发到达不会算出数万 tok/s", () => {
  // 真实序列：流从 0 起表，20 秒累计 1000 token，此时一次性到达 5000 token。
  // 短窗口斜率会得到 5000/0.05s = 100000 tok/s；累计平均只到 6000/20s ≈ 307。
  let state = advanceStreamingThroughputState(createStreamingThroughputState(), {
    key: "row-1",
    tokens: 0,
    nowMs: 0,
  });
  state = advanceStreamingThroughputState(state, { key: "row-1", tokens: 50, nowMs: 1_000 });
  state = advanceStreamingThroughputState(state, { key: "row-1", tokens: 1_000, nowMs: 20_000 });
  const burst = advanceStreamingThroughputState(state, {
    key: "row-1",
    tokens: 6_000,
    nowMs: 20_050,
  });
  const tps = resolveStreamingTokensPerSecond(burst, 20_050);
  assert.ok(tps !== null && tps < 400, `expected bounded tps, got ${tps}`);
});

test("起表后不足最短时长不发布，避免除以极小时间", () => {
  let state = advanceStreamingThroughputState(createStreamingThroughputState(), {
    key: "row-1",
    tokens: 0,
    nowMs: 1_000,
  });
  // 首个 token 到达即起表（此刻的 50 token 作为基线，不参与分子）。
  state = advanceStreamingThroughputState(state, { key: "row-1", tokens: 50, nowMs: 1_100 });
  state = advanceStreamingThroughputState(state, { key: "row-1", tokens: 100, nowMs: 1_600 });
  // 起表仅 0ms / 50ms 时不发布，否则 50 token / 0.05s 就是 1000 tok/s 假值。
  assert.equal(resolveStreamingTokensPerSecond(state, 1_100), null);
  assert.equal(resolveStreamingTokensPerSecond(state, 1_150), null);
  // 达到 500ms 后按累计平均发布：50 token / 0.5s = 100。
  assert.equal(resolveStreamingTokensPerSecond(state, 1_600), 100);
});

test("静默超过窗口后回落（返回 null 交给精确值）", () => {
  let state = advanceStreamingThroughputState(createStreamingThroughputState(), {
    key: "row-1",
    tokens: 0,
    nowMs: 0,
  });
  state = advanceStreamingThroughputState(state, { key: "row-1", tokens: 500, nowMs: 10_000 });
  state = advanceStreamingThroughputState(state, { key: "row-1", tokens: 1_000, nowMs: 10_500 });
  // 500 token / 0.5s = 1000，此时流仍活跃。
  assert.equal(resolveStreamingTokensPerSecond(state, 10_500), 1_000);
  // 静默超过 2s：流已暂停，回落精确值。
  assert.equal(resolveStreamingTokensPerSecond(state, 13_000), null);
});

test("新流开始重启测量：前一段已完成内容不计入分子", () => {
  // 第一段流：行先建出来（0 token），1 秒时 500 token 起表，10 秒时累计 5000。
  let state = advanceStreamingThroughputState(createStreamingThroughputState(), {
    key: "row-1",
    tokens: 0,
    nowMs: 0,
  });
  state = advanceStreamingThroughputState(state, { key: "row-1", tokens: 500, nowMs: 1_000 });
  state = advanceStreamingThroughputState(state, { key: "row-1", tokens: 5_000, nowMs: 10_000 });
  // (5000-500) token / 9s = 500。
  assert.equal(resolveStreamingTokensPerSecond(state, 10_000), 500);
  // 第二段流（思考结束、正文开始）：起点重置，分子从 0 起算。
  state = advanceStreamingThroughputState(state, { key: "row-2", tokens: 5_000, nowMs: 20_000 });
  state = advanceStreamingThroughputState(state, { key: "row-2", tokens: 5_100, nowMs: 21_000 });
  // 100 token / 1s = 100，而不是 5100/1s = 5100。
  assert.equal(resolveStreamingTokensPerSecond(state, 21_000), 100);
});

test("文本回缩与投影跳变都重启测量，跳变不被算成速度", () => {
  const state = advanceStreamingThroughputState(createStreamingThroughputState(), {
    key: "row-1",
    tokens: 1_000,
    nowMs: 10_000,
  });
  const shrunk = advanceStreamingThroughputState(state, {
    key: "row-1",
    tokens: 400,
    nowMs: 10_500,
  });
  assert.equal(shrunk.baselineTokens, 400);
  assert.equal(resolveStreamingTokensPerSecond(shrunk, 10_500), null);

  const jumped = advanceStreamingThroughputState(state, {
    key: "row-1",
    tokens: 1_000 + MAX_STREAMING_TOKEN_JUMP + 1,
    nowMs: 10_500,
  });
  assert.equal(jumped.baselineTokens, 1_000 + MAX_STREAMING_TOKEN_JUMP + 1);
  assert.equal(resolveStreamingTokensPerSecond(jumped, 10_500), null);
});
