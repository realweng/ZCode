import {
  SessionEventType,
  type ModelNetworkStatusPayload,
  type SessionEvent,
} from "@zcode/contracts";
import {
  SESSION_DEBUG_LIMITS,
  calculateOutputTps,
  sessionDebugParamsSchema,
  zcodeTaskNetworkDebugStatusFromPayload,
  type SessionDebugSnapshot,
} from "@zcode/shared";
import { requireSession, type ZCodeProtocolAgentServerContext } from "./server-types.js";

type SessionRecord = { app: { sessionId: string } };
interface Observation {
  snapshot: SessionDebugSnapshot;
  seenEvents: Set<string>;
  completedRequests: Set<string>;
  hasUnknownCacheUsage: boolean;
}
// 旁路记录跟随 CLI record 回收，不挂到聊天投影、轮次事实或已提交输入队列上。
const observations = new WeakMap<SessionRecord, Observation>();
const MAX_HEADER_COUNT = 32;
const MAX_HEADER_VALUE_LENGTH = 512;
const MAX_MESSAGE_LENGTH = 2048;
const MAX_DETACHED_CHILD_OBSERVATIONS = 16;
const detachedChildObservations = new Map<string, Observation>();

function emptySnapshot(sessionId: string): SessionDebugSnapshot {
  return { sessionId, rounds: [], networkEntries: [], cache: null };
}
function remember(keys: Set<string>, key: string): boolean {
  if (keys.has(key)) return false;
  keys.add(key);
  if (keys.size > SESSION_DEBUG_LIMITS.dedupe) keys.delete(keys.values().next().value!);
  return true;
}
function boundedHeaders(headers: Record<string, string>): Record<string, string> {
  // adapter 已脱敏；此处只限制调试响应体积，不保存正文，也不复制无限大小的 headers。
  return Object.fromEntries(
    Object.entries(headers)
      .slice(0, MAX_HEADER_COUNT)
      .map(([key, value]) => [
        key.slice(0, MAX_HEADER_VALUE_LENGTH),
        value.slice(0, MAX_HEADER_VALUE_LENGTH),
      ]),
  );
}
function token(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function createObservation(sessionId: string): Observation {
  return {
    snapshot: emptySnapshot(sessionId),
    seenEvents: new Set(),
    completedRequests: new Set(),
    hasUnknownCacheUsage: false,
  };
}

export function observeSessionDebug(record: SessionRecord, event: SessionEvent): void {
  if (
    event.type !== SessionEventType.ModelNetworkStatus ||
    String(event.sessionId) !== record.app.sessionId
  )
    return;
  let observation = observations.get(record);
  if (!observation) {
    observation = createObservation(record.app.sessionId);
    observations.set(record, observation);
  }
  applySessionDebugEvent(observation, record.app.sessionId, event);
}

/**
 * subagent child 的模型请求事件不会经过任何父 record（server-operations 按 sessionId
 * 提前分流进 v4 detached live session），session/debug 因此查不到子会话吞吐。
 * 子会话观测与父会话同构：同样只记 querySource=main_turn 的 completed round，
 * 供状态面板 Agents 行与子会话详情窗格轮询。
 */
export function observeDetachedChildSessionDebug(sessionId: string, event: SessionEvent): void {
  if (event.type !== SessionEventType.ModelNetworkStatus) return;
  let observation = detachedChildObservations.get(sessionId);
  if (!observation) {
    // child 是一次性 session，观测只服务打开中的窗格与运行行；FIFO 有界，
    // 不随会话生命周期挂到进程退出。
    if (detachedChildObservations.size >= MAX_DETACHED_CHILD_OBSERVATIONS) {
      const oldest = detachedChildObservations.keys().next().value;
      if (oldest !== undefined) detachedChildObservations.delete(oldest);
    }
    observation = createObservation(sessionId);
    detachedChildObservations.set(sessionId, observation);
  }
  applySessionDebugEvent(observation, sessionId, event);
}

export function readDetachedChildSessionDebug(sessionId: string): SessionDebugSnapshot | undefined {
  return detachedChildObservations.get(sessionId)?.snapshot;
}

function applySessionDebugEvent(
  observation: Observation,
  sessionId: string,
  event: SessionEvent,
): void {
  if (
    event.type !== SessionEventType.ModelNetworkStatus ||
    String(event.sessionId) !== sessionId
  )
    return;
  const payload = event.payload as ModelNetworkStatusPayload;
  const mapped = zcodeTaskNetworkDebugStatusFromPayload({
    taskId: sessionId,
    traceId: event.traceId,
    eventId: String(event.id),
    payload: { ...payload, model: { providerId: payload.providerId, modelId: payload.modelId } },
  });
  if (!mapped) return;
  if (!remember(observation.seenEvents, String(event.id))) return;
  const { type: _type, taskId: _taskId, eventId: _eventId, inputId: _inputId, ...entry } = mapped;
  const parsedAt = Date.parse(payload.timestamp);
  const recordedAt = Number.isFinite(parsedAt) ? parsedAt : event.timestamp.getTime();
  const state = observation.snapshot;
  state.networkEntries = [
    ...state.networkEntries,
    {
      ...entry,
      recordedAt,
      // maxAttempts=0 表示无限重试，旧映射器会丢掉它，调试面必须保留。
      maxAttempts: payload.maxAttempts,
      requestHeaders: boundedHeaders(entry.requestHeaders),
      responseHeaders: boundedHeaders(entry.responseHeaders),
      ...(entry.message ? { message: entry.message.slice(0, MAX_MESSAGE_LENGTH) } : {}),
    },
  ].slice(-SESSION_DEBUG_LIMITS.network);
  if (
    payload.type !== "model_request_completed" ||
    payload.querySource !== "main_turn" ||
    !remember(observation.completedRequests, payload.requestId)
  )
    return;
  const usage = payload.usage;
  const inputTokens = token(usage?.inputTokens);
  const outputTokens = token(usage?.outputTokens);
  const cacheReadTokens = token(usage?.cacheReadTokens);
  const duration = token(payload.durationMs);
  const first = token(payload.timeToFirstContentMs);
  const generationDurationMs =
    duration !== undefined && first !== undefined && duration > first ? duration - first : null;
  observation.hasUnknownCacheUsage ||= inputTokens === undefined || cacheReadTokens === undefined;
  const previous = state.cache;
  const totalInputTokens = (previous?.totalInputTokens ?? 0) + (inputTokens ?? 0);
  const totalCacheReadTokens = (previous?.totalCacheReadTokens ?? 0) + (cacheReadTokens ?? 0);
  const requestIndex = (previous?.hitRateRequestCount ?? 0) + 1;
  state.cache = {
    hitRateRequestCount: requestIndex,
    totalInputTokens,
    totalCacheReadTokens,
    hitRate:
      !observation.hasUnknownCacheUsage && totalInputTokens > 0
        ? totalCacheReadTokens / totalInputTokens
        : null,
  };
  state.rounds = [
    ...state.rounds,
    {
      eventKey: String(event.id),
      requestId: payload.requestId,
      requestIndex,
      recordedAt,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens:
          token(usage?.totalTokens) ??
          (inputTokens !== undefined && outputTokens !== undefined
            ? inputTokens + outputTokens
            : undefined),
        reasoningTokens: token(usage?.reasoningTokens),
        cachedInputTokens: cacheReadTokens,
        cachedWriteInputTokens: token(usage?.cacheWriteTokens),
      },
      hitRate:
        inputTokens !== undefined && inputTokens > 0 && cacheReadTokens !== undefined
          ? cacheReadTokens / inputTokens
          : null,
      generationDurationMs,
      tokensPerSecond: calculateOutputTps(outputTokens, generationDurationMs),
    },
  ].slice(-SESSION_DEBUG_LIMITS.rounds);
}

export function readSessionDebug(record: SessionRecord): SessionDebugSnapshot {
  return observations.get(record)?.snapshot ?? emptySnapshot(record.app.sessionId);
}

export function querySessionDebug(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): SessionDebugSnapshot {
  const params = sessionDebugParamsSchema.parse(rawParams);
  // 父会话优先走活跃 record；subagent child 没有 record，落在 detached 观测上。
  // 两者都没有时交给 requireSession 抛出带诊断日志的 sessionUnavailable。
  const record = context.sessions.get(params.sessionId);
  if (record) return readSessionDebug(record);
  const childSnapshot = readDetachedChildSessionDebug(params.sessionId);
  if (childSnapshot) return childSnapshot;
  return readSessionDebug(requireSession(context, params.sessionId, { operation: "sessionDebug" }));
}
