// ============================================================
// Observation Pack Controller - 状态所有者与投影前置变换
// ============================================================
// 唯一状态所有者：per-runtime 实例（AgentRuntime 构造时创建），持有观察记录表与
// 全量发送计数。投影变换只产生新数组，输入的 canonical/query-local entries 不被修改。
//
// 事件顺序（每个 model step 一次，先于 buildRuntimeProviderRequestMessages）：
//   turn-loop → projectEntries(entries)
//     ├─ 首次命中：归档到 ToolArtifactStore（fail-open，失败不记录、不替换）
//     ├─ fullSends < N：原样通过，计数 +1
//     └─ fullSends ≥ N：替换为占位符（仅投影副本）
//   ObsRecall(id, offset) → readToolResultArtifact → 字节分页
//
// resume/rewind 后计数归零（内存态）：安全默认是重新全量发送 N 次，绝不凭空替换。

import type { SessionId, ToolArtifactStorePort, TraceContext } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import {
  buildObservationPlaceholder,
  qualifyObservationEntry,
} from "./observation.js";
import {
  OBSERVATION_FULL_SENDS,
  OBSERVATION_RECALL_MAX_BYTES,
  OBSERVATION_RECALL_MAX_LINES,
  OBSERVATION_THRESHOLD_BYTES,
  type ObservationPackControllerOptions,
  type ObservationProjectionResult,
  type ObservationRecallResult,
  type ObservationRecord,
} from "./types.js";

interface ObservationRecordState extends ObservationRecord {
  fullSends: number;
}

export class ObservationPackController {
  private readonly sessionId: SessionId;
  private readonly artifactStore: ToolArtifactStorePort;
  private readonly thresholdBytes: number;
  private readonly fullSendsLimit: number;
  private readonly records = new Map<string, ObservationRecordState>();

  constructor(options: ObservationPackControllerOptions) {
    this.sessionId = options.sessionId;
    this.artifactStore = options.artifactStore;
    this.thresholdBytes = options.thresholdBytes ?? OBSERVATION_THRESHOLD_BYTES;
    this.fullSendsLimit = options.fullSends ?? OBSERVATION_FULL_SENDS;
  }

  /**
   * 投影前置变换：归档新观察、按发送计数决定全量或占位符。
   * 任何一步失败都让该条目原样通过（fail-open），不中断 model step。
   */
  async projectEntries(
    entries: readonly RuntimeMessageEntry[],
    context?: { trace?: TraceContext },
  ): Promise<ObservationProjectionResult> {
    const projected: RuntimeMessageEntry[] = [];
    let packedCount = 0;
    let fullSendCount = 0;

    for (const entry of entries) {
      if (entry.kind === "attachment") {
        projected.push(entry);
        continue;
      }
      const qualified = qualifyObservationEntry(entry, this.thresholdBytes);
      if (qualified === undefined) {
        projected.push(entry);
        continue;
      }
      const record = await this.ensureRecord(qualified, context?.trace);
      if (record === undefined) {
        // 归档失败：fail-open，原文全量发送且不计数（下次投影重试归档）。
        projected.push(entry);
        continue;
      }
      if (record.fullSends < this.fullSendsLimit) {
        record.fullSends += 1;
        fullSendCount += 1;
        projected.push(entry);
        continue;
      }
      packedCount += 1;
      projected.push({
        ...entry,
        message: {
          ...entry.message,
          content: [{ type: "text", text: buildObservationPlaceholder({
            id: record.id,
            toolName: record.toolName,
            originalText: qualified.text,
            originalBytes: record.originalBytes,
            originalLines: record.originalLines,
            estimatedTokens: record.estimatedTokens,
            fullSends: this.fullSendsLimit,
          }) }],
        },
      });
    }

    return {
      entries: packedCount > 0 ? projected : entries,
      packedCount,
      fullSendCount,
    };
  }

  async recall(input: { id: string; offset?: number }): Promise<ObservationRecallResult> {
    const record = this.records.get(input.id);
    if (record === undefined) {
      return {
        result: false,
        reason: "unknown_id",
        message: `unknown observation id: ${input.id}`,
      };
    }
    if (record.artifactUri === undefined) {
      return {
        result: false,
        reason: "artifact_unavailable",
        message: `observation ${input.id} has no archived artifact`,
      };
    }
    let content: string;
    try {
      const read = await this.artifactStore.readToolResultArtifact({ uri: record.artifactUri });
      content = read.content;
    } catch {
      return {
        result: false,
        reason: "artifact_unavailable",
        message: `failed to read archived observation ${input.id}`,
      };
    }
    const bytes = Buffer.from(content, "utf8");
    const offset = Math.max(0, Math.min(Math.trunc(input.offset ?? 0), bytes.length));
    return {
      result: true,
      id: record.id,
      ...recallChunk(bytes, offset),
    };
  }

  private async ensureRecord(
    qualified: { id: string; toolName: string; toolCallId: string; text: string; bytes: number; lines: number; estimatedTokens: number },
    trace?: TraceContext,
  ): Promise<ObservationRecordState | undefined> {
    const existing = this.records.get(qualified.id);
    if (existing !== undefined) return existing;
    try {
      const write = await this.artifactStore.writeToolResultArtifact(
        {
          sessionId: this.sessionId,
          toolCallId: qualified.toolCallId,
          toolName: qualified.toolName,
          content: qualified.text,
          contentType: "text/plain",
          retention: "session",
          ...(trace ? { trace } : {}),
        },
      );
      const record: ObservationRecordState = {
        id: qualified.id,
        toolName: qualified.toolName,
        toolCallId: qualified.toolCallId,
        originalBytes: qualified.bytes,
        originalLines: qualified.lines,
        estimatedTokens: qualified.estimatedTokens,
        artifactUri: write.uri,
        fullSends: 0,
      };
      this.records.set(qualified.id, record);
      return record;
    } catch {
      // fail-open：归档失败不记录，条目保持全量；下个 model step 重试。
      return undefined;
    }
  }
}

/** 字节分页：尾部剪掉不完整的 UTF-8 序列，再按行数上限截断。 */
function recallChunk(
  bytes: Buffer,
  offset: number,
): { text: string; offset: number; nextOffset: number; eof: boolean } {
  let end = Math.min(offset + OBSERVATION_RECALL_MAX_BYTES, bytes.length);
  while (end > offset && (bytes[end - 1]! & 0xc0) === 0x80) end -= 1;
  if (end > offset && (bytes[end - 1]! & 0x80) !== 0) end -= 1;

  let chunk = bytes.subarray(offset, end);
  const firstNewlineAfterLimit = findNthNewline(chunk, OBSERVATION_RECALL_MAX_LINES);
  if (firstNewlineAfterLimit !== undefined) {
    chunk = chunk.subarray(0, firstNewlineAfterLimit);
  }

  const nextOffset = offset + chunk.length;
  return {
    text: chunk.toString("utf8"),
    offset,
    nextOffset,
    eof: nextOffset >= bytes.length,
  };
}

/** 返回第 `maxLines` 个换行符之后的位置（即前 maxLines 行的结尾）；不足 maxLines 行返回 undefined。 */
function findNthNewline(chunk: Buffer, maxLines: number): number | undefined {
  let seen = 0;
  for (let index = 0; index < chunk.length; index++) {
    if (chunk[index] === 0x0a) {
      seen += 1;
      if (seen >= maxLines) return index + 1;
    }
  }
  return undefined;
}
