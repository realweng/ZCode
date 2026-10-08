import { useEffect, useMemo, useRef, useState } from "react";
import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "@zcode/shared";
import type { AssistantWorkRow } from "@/v4/conversationTurnFlowItems.js";

/**
 * 流式 token 估算：与 CLI 侧 `estimateTokens`
 * （apps/zcode-cli/packages/core/src/context/utils.ts）刻意保持同一公式——
 * 中文字符按 2 个估算字符计入，除以共享常量。改公式必须两边同步。
 * 这是展示层估算，不是协议事实；界面用 `~` 前缀区分精确值。
 */
export function estimateStreamingTokens(text: string): number {
  const chineseChars = (text.match(/[一-鿿]/gu) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil((chineseChars * 2 + otherChars) / ESTIMATED_TOKEN_CHAR_DIVISOR);
}

export interface StreamingThroughputSample {
  atMs: number;
  tokens: number;
}

export const STREAMING_THROUGHPUT_WINDOW_MS = 4_000;
/** 样本跨度低于该值时斜率不可信（单批 delta 的突发速度不代表持续吞吐）。 */
export const STREAMING_THROUGHPUT_MIN_SPAN_MS = 800;
/** 最新样本静默超过该值视为流已暂停（工具执行/请求间隙），回落到精确值。 */
export const STREAMING_THROUGHPUT_STALE_MS = 2_000;

/**
 * 滑动窗口斜率：取窗口内 (首样本, 末样本) 的 token 差 / 时间差。
 * 跨度不足、增量非正或样本过期时返回 null——宁缺毋假，静默期由调用方
 * 回落到最近一次已完成请求的精确吞吐。
 */
export function resolveStreamingTokensPerSecond(
  samples: readonly StreamingThroughputSample[],
  nowMs: number,
  options: {
    minSpanMs?: number;
    staleMs?: number;
    windowMs?: number;
  } = {},
): number | null {
  const {
    minSpanMs = STREAMING_THROUGHPUT_MIN_SPAN_MS,
    staleMs = STREAMING_THROUGHPUT_STALE_MS,
    windowMs = STREAMING_THROUGHPUT_WINDOW_MS,
  } = options;
  const newest = samples.at(-1);
  if (!newest || nowMs - newest.atMs > staleMs) return null;
  const windowStart = newest.atMs - windowMs;
  const first = samples.find((sample) => sample.atMs >= windowStart);
  if (!first) return null;
  const spanMs = newest.atMs - first.atMs;
  if (spanMs < minSpanMs) return null;
  const deltaTokens = newest.tokens - first.tokens;
  if (deltaTokens <= 0) return null;
  const tokensPerSecond = (deltaTokens * 1_000) / spanMs;
  return Number.isFinite(tokensPerSecond) && tokensPerSecond > 0 ? tokensPerSecond : null;
}

/**
 * 实时流式吞吐（估算）。text 是当前运行段 reasoning/assistantText 行的累计文本：
 * 每次 delta 都会改变它并落入 effect 记为样本；窗口斜率即为 tok/s。
 * 文本回缩（投影 resync / 行重建）时重置样本，避免负斜率污染窗口。
 */
export function useStreamingThroughput({
  enabled,
  text,
}: {
  enabled: boolean;
  text: string;
}): number | null {
  const samplesRef = useRef<StreamingThroughputSample[]>([]);
  const [tokensPerSecond, setTokensPerSecond] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      samplesRef.current = [];
      setTokensPerSecond(null);
      return;
    }
    const nowMs = Date.now();
    const tokens = estimateStreamingTokens(text);
    const samples = samplesRef.current;
    const previous = samples.at(-1);
    if (previous && tokens < previous.tokens) {
      samplesRef.current = [{ atMs: nowMs, tokens }];
    } else {
      samples.push({ atMs: nowMs, tokens });
    }
    setTokensPerSecond(resolveStreamingTokensPerSecond(samplesRef.current, nowMs));
  }, [enabled, text]);

  useEffect(() => {
    if (!enabled) return;
    // 秒针：流静默时让估算值按窗口自然衰减回落，而不是停在最后一次 delta 的数上。
    const timer = window.setInterval(() => {
      setTokensPerSecond(resolveStreamingTokensPerSecond(samplesRef.current, Date.now()));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [enabled]);

  return tokensPerSecond;
}

/** 运行段内 reasoning 与 assistantText 行的累计文本（估算输入）。 */
export function useSegmentStreamingText(rows: readonly AssistantWorkRow[]): string {
  return useMemo(
    () =>
      rows
        .map((row) => (row.kind === "reasoning" || row.kind === "assistantText" ? row.text : ""))
        .join(""),
    [rows],
  );
}
