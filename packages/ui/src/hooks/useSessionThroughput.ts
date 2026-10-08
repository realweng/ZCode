import { useMemo } from "react";
import type { SessionDebugSnapshot } from "@zcode/shared";
import { useSessionDebug } from "@/hooks/useSessionDebug.js";

/**
 * 解码窗口的可信下限。响应被代理/网络整包缓冲后一次到达时，
 * durationMs - TTFT 会塌缩到几十毫秒以内，此时 outputTokens / 窗口 会算出
 * 数万 tok/s 的假尖峰（实测环境：Clash 类代理的 SSE 缓冲）。低于该窗口的
 * round 不作为展示事实；开发者面板继续显示原始值以便诊断。
 */
export const MIN_RELIABLE_GENERATION_DURATION_MS = 100;

/**
 * 最近一次**可信**模型请求的输出吞吐。从末尾向前找第一条解码窗口达标的
 * round；突发到达的 round 被跳过而不是冒充当前事实。找不到可信 round 或
 * 其吞吐未知（null）时保持缺席。
 */
export function resolveLatestTokensPerSecond(
  rounds: readonly SessionDebugSnapshot["rounds"][number][],
): number | null {
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const round = rounds[index]!;
    if (
      round.generationDurationMs !== null &&
      round.generationDurationMs < MIN_RELIABLE_GENERATION_DURATION_MS
    ) {
      continue;
    }
    return round.tokensPerSecond ?? null;
  }
  return null;
}

export function formatTokensPerSecond(locale: string, tokensPerSecond: number): string {
  // 与开发者工具面板 TPS 列同格式：一位小数，tabular 渲染由样式负责。
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(tokensPerSecond);
}

/**
 * 会话实时吞吐（tok/s）。事实源是 agent 侧 session/debug 观测（每个已完成模型请求
 * 的 outputTokens / 解码时长），这里只按秒轮询读取，不做本地 Δtoken/Δt 推导。
 */
export function useSessionThroughput({
  enabled,
  sessionId,
  workspaceIdentity,
  workspacePath,
}: {
  enabled: boolean;
  sessionId: string | null | undefined;
  workspaceIdentity?: string;
  workspacePath: string;
}): { tokensPerSecond: number | null } {
  const debugState = useSessionDebug({
    enabled: enabled && typeof sessionId === "string" && sessionId.length > 0,
    taskId: sessionId ?? null,
    workspaceIdentity,
    workspacePath,
  });
  const rounds = debugState.rounds;
  return useMemo(() => ({ tokensPerSecond: resolveLatestTokensPerSecond(rounds) }), [rounds]);
}
