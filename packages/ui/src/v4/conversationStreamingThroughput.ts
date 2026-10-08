import { useEffect, useRef, useState } from "react";
import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "@zcode/shared";
import type { AssistantWorkRow } from "@/v4/conversationTurnFlowItems.js";

/**
 * 流式 token 估算：与 CLI 侧 `estimateTokens`
 * （apps/zcode-cli/packages/core/src/context/utils.ts）刻意保持同一公式——
 * 中文字符按 2 个估算字符计入，除以共享常量。改公式必须两边同步。
 * 这是展示层估算，不是协议事实；界面用 `~` 前缀区分精确值。
 */
function estimateTokensFloat(text: string): number {
  const chineseChars = (text.match(/[一-鿿]/gu) || []).length;
  const otherChars = text.length - chineseChars;
  return (chineseChars * 2 + otherChars) / ESTIMATED_TOKEN_CHAR_DIVISOR;
}

export function estimateStreamingTokens(text: string): number {
  return Math.ceil(estimateTokensFloat(text));
}

export interface StreamingTokenEstimate {
  text: string;
  tokens: number;
}

/**
 * 增量估算：流式文本只在尾部追加，每次 delta 重算全文会让长回复退化成 O(n²)
 * （数万字符 × 每秒多次）。前缀未变时只估算新增后缀并累加；前缀被改写
 * （投影重建）时退回全文重算。
 */
export function estimateIncrementalTokens(
  previous: StreamingTokenEstimate | null,
  text: string,
): StreamingTokenEstimate {
  if (!previous || !text.startsWith(previous.text)) {
    return { text, tokens: estimateTokensFloat(text) };
  }
  if (text.length === previous.text.length) return previous;
  return {
    text,
    tokens: previous.tokens + estimateTokensFloat(text.slice(previous.text.length)),
  };
}

export const STREAMING_THROUGHPUT_TICK_MS = 300;
/** 流开始后的最短观测时长；低于它不发布，避免除以极小时间得到假速度。 */
export const STREAMING_THROUGHPUT_MIN_ELAPSED_MS = 500;
/** 最新增量静默超过该值视为流已暂停（工具执行/请求间隙），回落到精确值。 */
export const STREAMING_THROUGHPUT_STALE_MS = 2_000;
/**
 * 单次增量上限。真实 delta 经投影分帧后远小于该值；超过它只可能来自投影跳变
 * （snapshot resync、断流恢复重开行导致新旧内容短暂并存），必须重启测量而不是
 * 把跳变算成速度。
 */
export const MAX_STREAMING_TOKEN_JUMP = 12_000;

export interface StreamingThroughputState {
  /** 当前流式内容集合的身份；变化即代表上一段流结束、新一段开始。 */
  key: string | null;
  /** 本次测量起点的 token 数（上一段已完成内容不计入分子）。 */
  baselineTokens: number;
  /** 测量起点时间；起点 token 为 0 时留空，等首个 token 到达再起表。 */
  startedAtMs: number | null;
  /** 最近一次 token 增长时间，用于静默判定。 */
  lastGrowthAtMs: number;
  tokens: number;
}

export function createStreamingThroughputState(): StreamingThroughputState {
  return {
    key: null,
    baselineTokens: 0,
    startedAtMs: null,
    lastGrowthAtMs: 0,
    tokens: 0,
  };
}

function restartStreamingMeasurement(
  key: string | null,
  tokens: number,
  nowMs: number,
): StreamingThroughputState {
  return {
    key,
    baselineTokens: tokens,
    // 起点已有内容（例如投影重建后带着文本重开）时立即起表，否则等首个 token。
    startedAtMs: tokens > 0 ? nowMs : null,
    lastGrowthAtMs: nowMs,
    tokens,
  };
}

/**
 * 推进测量状态。新流开始、文本回缩（投影重建）或增量超出物理上限（投影跳变）时
 * 重启测量；其余情况沿用起点，只在分子上累加。
 */
export function advanceStreamingThroughputState(
  state: StreamingThroughputState,
  input: { key: string | null; tokens: number; nowMs: number },
): StreamingThroughputState {
  const { key, tokens, nowMs } = input;
  if (state.key !== key) {
    return restartStreamingMeasurement(key, tokens, nowMs);
  }
  if (tokens < state.tokens || tokens - state.tokens > MAX_STREAMING_TOKEN_JUMP) {
    return restartStreamingMeasurement(key, tokens, nowMs);
  }
  if (state.startedAtMs === null) {
    if (tokens <= state.baselineTokens) {
      return { ...state, lastGrowthAtMs: nowMs, tokens };
    }
    // 起表这一刻才第一次看到 token：它们的到达时间未知，只能作为基线，
    // 只计量此后新增的部分。否则首批 token 会被整段算成分子，又变成假尖峰。
    return { ...state, baselineTokens: tokens, startedAtMs: nowMs, lastGrowthAtMs: nowMs, tokens };
  }
  return { ...state, lastGrowthAtMs: nowMs, tokens };
}

/**
 * 速度 = 本次测量起点以来的**累计平均**吞吐（累计 token / 累计时长）。
 * 累计口径是关键：突发到达的一批 token 只让分子一次性增加，而分母已覆盖整段时长，
 * 因此不会像短窗口斜率那样算出数万 tok/s。静默、时长不足或增量为零时返回 null，
 * 由调用方回落到 agent 侧的精确值。
 */
export function resolveStreamingTokensPerSecond(
  state: StreamingThroughputState,
  nowMs: number,
  options: {
    minElapsedMs?: number;
    staleMs?: number;
  } = {},
): number | null {
  const {
    minElapsedMs = STREAMING_THROUGHPUT_MIN_ELAPSED_MS,
    staleMs = STREAMING_THROUGHPUT_STALE_MS,
  } = options;
  if (state.startedAtMs === null) return null;
  if (nowMs - state.lastGrowthAtMs > staleMs) return null;
  const elapsedMs = nowMs - state.startedAtMs;
  if (elapsedMs < minElapsedMs) return null;
  const deltaTokens = state.tokens - state.baselineTokens;
  if (deltaTokens <= 0) return null;
  const tokensPerSecond = (deltaTokens * 1_000) / elapsedMs;
  return Number.isFinite(tokensPerSecond) && tokensPerSecond > 0 ? tokensPerSecond : null;
}

/**
 * 当前正在流式输出的内容：正文/思考按 `state === "streaming"`，工具入参按
 * `status === "inputStreaming"`（模型写工具参数同样是输出 token）。
 * 只取正在流式的行，已完成的历史内容不进入分子——否则多请求的工作段里，
 * 新请求起表时会被旧文本顶出一个假尖峰。
 */
export function resolveSegmentStreamingContent(rows: readonly AssistantWorkRow[]): {
  key: string | null;
  text: string;
} {
  let key: string | null = null;
  let text = "";
  for (const row of rows) {
    if (row.kind === "reasoning" || row.kind === "assistantText") {
      if (row.state !== "streaming") continue;
      text += row.text;
    } else if (row.kind === "toolCall") {
      if (row.status !== "inputStreaming") continue;
      text += row.inputText;
    } else {
      continue;
    }
    key = key === null ? String(row.rowId) : `${key},${row.rowId}`;
  }
  return { key, text };
}

/**
 * 实时流式吞吐（估算）。流式期间按 300ms tick 重算累计平均速度；
 * 静默或时长不足时返回 null，由调用方回落到精确值。
 */
export function useStreamingThroughput({
  enabled,
  contentKey,
  text,
}: {
  enabled: boolean;
  contentKey: string | null;
  text: string;
}): number | null {
  const stateRef = useRef<StreamingThroughputState>(createStreamingThroughputState());
  const estimateRef = useRef<StreamingTokenEstimate | null>(null);
  const [tokensPerSecond, setTokensPerSecond] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      stateRef.current = createStreamingThroughputState();
      estimateRef.current = null;
      setTokensPerSecond(null);
      return;
    }
    const nowMs = Date.now();
    const estimate = estimateIncrementalTokens(estimateRef.current, text);
    estimateRef.current = estimate;
    const state = advanceStreamingThroughputState(stateRef.current, {
      key: contentKey,
      tokens: estimate.tokens,
      nowMs,
    });
    stateRef.current = state;
    setTokensPerSecond(resolveStreamingTokensPerSecond(state, nowMs));
  }, [enabled, contentKey, text]);

  useEffect(() => {
    if (!enabled) return;
    // 定时 tick：累计平均随时间自然收敛，并在流静默后按窗口回落。
    const timer = window.setInterval(() => {
      setTokensPerSecond(resolveStreamingTokensPerSecond(stateRef.current, Date.now()));
    }, STREAMING_THROUGHPUT_TICK_MS);
    return () => window.clearInterval(timer);
  }, [enabled]);

  return tokensPerSecond;
}
