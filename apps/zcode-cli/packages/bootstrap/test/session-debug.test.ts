import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import {
  observeDetachedChildSessionDebug,
  querySessionDebug,
  readDetachedChildSessionDebug,
} from "../src/zcode-protocol/session-debug.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

// session-debug 的观测表是模块级状态，测试间不得复用同一 sessionId。
let eventSeq = 0;

function completedEvent(sessionId: string, requestId: string) {
  eventSeq += 1;
  return {
    id: eventSeq,
    sessionId,
    type: SessionEventType.ModelNetworkStatus,
    traceId: `trace-${sessionId}`,
    timestamp: new Date(0),
    payload: {
      type: "model_request_completed",
      querySource: "main_turn",
      requestId,
      providerId: "glm",
      modelId: "glm-test",
      timestamp: "1970-01-01T00:00:00.000Z",
      durationMs: 4_000,
      timeToFirstContentMs: 1_000,
      usage: { inputTokens: 10, outputTokens: 120 },
    },
  } as unknown as SessionEvent;
}

function fakeContext(sessions = new Map<string, { app: { sessionId: string } }>()) {
  return {
    sessions,
    // requireSession 的缺 session 诊断会读 context.deps.sessionStore；deps 必须存在。
    deps: {},
    logger: {
      warn() {
        // 静默：缺 session 的诊断日志不属于本测试断言范围。
      },
    },
  } as unknown as ZCodeProtocolAgentServerContext;
}

test("detached child 观测记录子会话自己的 main_turn round", () => {
  observeDetachedChildSessionDebug("child-observe", completedEvent("child-observe", "req-1"));
  const snapshot = readDetachedChildSessionDebug("child-observe");
  assert.equal(snapshot?.sessionId, "child-observe");
  assert.equal(snapshot?.rounds.length, 1);
  const round = snapshot?.rounds[0];
  // 口径与父会话一致：解码时长 = duration - TTFT = 3s，120 tok → 40 tok/s。
  assert.equal(round?.usage.outputTokens, 120);
  assert.equal(round?.generationDurationMs, 3_000);
  assert.equal(round?.tokensPerSecond, 40);
});

test("child 观测只认本 child 的 sessionId，事件不得串写", () => {
  observeDetachedChildSessionDebug("child-guard", completedEvent("child-other", "req-1"));
  assert.equal(readDetachedChildSessionDebug("child-guard")?.rounds.length ?? 0, 0);
  assert.equal(readDetachedChildSessionDebug("child-other")?.rounds.length ?? 0, 0);
});

test("querySessionDebug：父 record 优先，缺席时回落 child 观测，两者皆无时报错", () => {
  const record = { app: { sessionId: "parent-query" } };
  const context = fakeContext(new Map([["parent-query", record]]));
  assert.equal(querySessionDebug(context, { sessionId: "parent-query" }).rounds.length, 0);

  observeDetachedChildSessionDebug("child-query", completedEvent("child-query", "req-1"));
  const childSnapshot = querySessionDebug(fakeContext(), { sessionId: "child-query" });
  assert.equal(childSnapshot.rounds.length, 1);
  assert.equal(childSnapshot.rounds[0]?.tokensPerSecond, 40);

  assert.throws(
    () => querySessionDebug(fakeContext(), { sessionId: "unknown-session" }),
    /Session is not active/,
  );
});
