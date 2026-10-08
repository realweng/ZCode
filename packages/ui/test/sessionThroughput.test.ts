import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTokensPerSecond,
  resolveLatestTokensPerSecond,
} from "../src/hooks/useSessionThroughput.js";
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
