import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTokensPerSecond,
  resolveLatestTokensPerSecond,
} from "../src/hooks/useSessionThroughput.js";
import {
  STREAMING_THROUGHPUT_MIN_SPAN_MS,
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

test("resolveStreamingTokensPerSecond 取窗口内首末样本斜率", () => {
  const now = 10_000;
  const samples = [
    { atMs: now - 3_000, tokens: 60 },
    { atMs: now - 1_000, tokens: 100 },
    { atMs: now, tokens: 120 },
  ];
  // 窗口起点 now-4s 覆盖全部样本：(120-60)/3s = 20。
  assert.equal(resolveStreamingTokensPerSecond(samples, now), 20);
});

test("跨度不足、增量非正、样本过期时返回 null", () => {
  const now = 10_000;
  // 单样本跨度为 0。
  assert.equal(resolveStreamingTokensPerSecond([{ atMs: now, tokens: 100 }], now), null);
  // 跨度足够但窗口内没有增量。
  assert.equal(
    resolveStreamingTokensPerSecond(
      [
        { atMs: now - 3_000, tokens: 100 },
        { atMs: now - STREAMING_THROUGHPUT_MIN_SPAN_MS, tokens: 100 },
      ],
      now,
    ),
    null,
  );
  // 最新样本静默超过 stale 阈值：流已暂停，回落精确值。
  assert.equal(
    resolveStreamingTokensPerSecond(
      [
        { atMs: now - 5_000, tokens: 10 },
        { atMs: now - 3_000, tokens: 100 },
      ],
      now,
    ),
    null,
  );
});

test("旧样本滑出窗口后不再参与斜率", () => {
  const now = 10_000;
  // 首样本在窗口（4s）外，斜率只取窗口内样本：(120-100)/1s = 20。
  const samples = [
    { atMs: now - 6_000, tokens: 0 },
    { atMs: now - 1_000, tokens: 100 },
    { atMs: now, tokens: 120 },
  ];
  assert.equal(resolveStreamingTokensPerSecond(samples, now), 20);
});
