import { useMemo } from "react";
import type { SessionDebugSnapshot } from "@zcode/shared";
import { useSessionDebug } from "@/hooks/useSessionDebug.js";

/**
 * 最近一次已完成模型请求的输出吞吐。只认 rounds 末条：更早的值代表更早的请求，
 * 回退展示会把旧事实冒充成当前事实；末条吞吐未知（null）时保持缺席。
 */
export function resolveLatestTokensPerSecond(
  rounds: readonly SessionDebugSnapshot["rounds"][number][],
): number | null {
  const latest = rounds.at(-1);
  return latest?.tokensPerSecond ?? null;
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
