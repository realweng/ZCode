// ============================================================
// Observation Pack Types - 大体积工具结果的句柄化投影（SoL-Pi 机制内化 P1）
// ============================================================
// 设计契约见 specs/harness-token-efficiency.md §4.1：
// - 只在 provider 请求投影层替换内容，权威历史（MessageHistory / SQLite parts）不变；
// - 前 N 次 provider 请求全量发送（FULL_SENDS），之后替换为占位符 + 首/尾摘录；
// - 原文归档进 ToolArtifactStore，模型经 ObsRecall 按字节偏移精确分页召回；
// - 任何归档/替换失败 fail-open：结果原样进入上下文。
// send-count 是投影层派生态：丢失只导致多全量发送几次（性能降级，非正确性问题）。

import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { SessionId } from "@zcode/contracts";
import type { ToolArtifactStorePort } from "@zcode/contracts";

/** 准入阈值：拼接文本超过该 UTF-8 字节数的工具结果才可句柄化（对齐 SoL-Pi 10 KiB）。 */
export const OBSERVATION_THRESHOLD_BYTES = 10_240;
/** 观察对象在替换为占位符之前的全量发送次数（对齐 SoL-Pi FULL_SENDS = 2）。 */
export const OBSERVATION_FULL_SENDS = 2;
/** 占位符中首/尾摘录的字节预算（对齐 SoL-Pi 512B x2，只取完整行）。 */
export const OBSERVATION_EXCERPT_BYTES = 512;
/** ObsRecall 单次返回上限（对齐 SoL-Pi 16 KiB / 400 行）。 */
export const OBSERVATION_RECALL_MAX_BYTES = 16_384;
export const OBSERVATION_RECALL_MAX_LINES = 400;

export interface ObservationPackRuntimeConfig {
  enabled?: boolean;
}

export interface ObservationRecord {
  /** `obs_` + 内容寻址哈希前缀；跨请求/跨投影稳定。 */
  id: string;
  toolName: string;
  toolCallId: string;
  originalBytes: number;
  originalLines: number;
  estimatedTokens: number;
  /** 归档产物的 store URI；归档失败时缺席，观察对象永不进入替换分支。 */
  artifactUri?: string;
  /** 该观察对象被全量计入 provider 请求的次数。 */
  fullSends: number;
}

/** ObsRecall 工具经 ToolExecutionContext 拿到的窄端口；与 readFileState 同款注入先例。 */
export interface ObservationRecallPort {
  recall(input: { id: string; offset?: number }): Promise<ObservationRecallResult>;
}

export type ObservationRecallResult =
  | { result: true; id: string; text: string; offset: number; nextOffset: number; eof: boolean }
  | { result: false; reason: "unknown_id" | "artifact_unavailable"; message: string };

export interface ObservationPackControllerOptions {
  sessionId: SessionId;
  artifactStore: ToolArtifactStorePort;
  /** 测试注入；生产走常量。 */
  thresholdBytes?: number;
  fullSends?: number;
}

/** 投影产物：新数组 + 替换统计；输入 entries 不被修改。 */
export interface ObservationProjectionResult {
  entries: readonly RuntimeMessageEntry[];
  packedCount: number;
  fullSendCount: number;
}
