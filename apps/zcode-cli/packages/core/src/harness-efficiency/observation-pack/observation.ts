// ============================================================
// Observation Qualification & Placeholder
// ============================================================
// 准入判定、观察 id 与占位符文本。纯函数、无 IO：controller 负责归档与计数，
// 本文件只回答「这个 tool result 算不算观察对象」和「模型该看到什么」。

import { createHash } from "node:crypto";
import type { ModelMessageContent, ModelMessageContentBlock } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { estimateTokens } from "../../context/utils.js";
import {
  OBSERVATION_EXCERPT_BYTES,
  OBSERVATION_THRESHOLD_BYTES,
} from "./types.js";

/** 占位符首行标记；同时用于防止占位符/归约 receipt 被二次打包。 */
export const OBSERVATION_PLACEHOLDER_MARKER = "[ObservationPack:";

export interface QualifiedObservation {
  toolName: string;
  toolCallId: string;
  text: string;
  bytes: number;
  lines: number;
  estimatedTokens: number;
  id: string;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  // 行数按换行符计；末尾换行不产生空行（与 SoL-Pi 口径一致）。
  let lines = 1;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  if (text.endsWith("\n")) lines -= 1;
  return lines;
}

function textContentToText(content: ModelMessageContent): string | undefined {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content as ModelMessageContentBlock[]) {
    if (block?.type !== "text" || typeof block.text !== "string") return undefined;
    parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * 准入：role 为 tool、非 error、内容全为文本、拼接后超过阈值。
 * 占位符自身（以及未来的 receipt）携带标记行，直接排除，防止二次打包。
 */
export function qualifyObservationEntry(
  entry: RuntimeMessageEntry,
  thresholdBytes: number,
): QualifiedObservation | undefined {
  if (entry.kind === "attachment") return undefined;
  const message = entry.message;
  if (message.role !== "tool" || !message.toolCallId) return undefined;
  if (message.isError) return undefined;
  const text = textContentToText(message.content);
  if (text === undefined) return undefined;
  if (text.includes(OBSERVATION_PLACEHOLDER_MARKER)) return undefined;
  const bytes = utf8Bytes(text);
  if (bytes <= thresholdBytes) return undefined;
  const toolName = message.toolName ?? "tool";
  const id = `obs_${createHash("sha256")
    .update(`${toolName}\0${message.toolCallId}\0${createHash("sha256").update(text).digest("hex")}`)
    .digest("hex")
    .slice(0, 24)}`;
  return {
    toolName,
    toolCallId: message.toolCallId,
    text,
    bytes,
    lines: countLines(text),
    estimatedTokens: estimateTokens(text),
    id,
  };
}

/** 首部/尾部整行摘录：单行超预算时整行跳过，不截半行。 */
function excerptLines(text: string, direction: "head" | "tail", budgetBytes: number): string {
  const source = text.split("\n");
  const lines = direction === "head" ? source : [...source].reverse();
  const picked: string[] = [];
  let used = 0;
  for (const line of lines) {
    const lineBytes = utf8Bytes(line) + 1;
    if (used + lineBytes > budgetBytes) continue;
    picked.push(line);
    used += lineBytes;
    if (used >= budgetBytes) break;
  }
  if (direction === "tail") picked.reverse();
  return picked.join("\n");
}

export function buildObservationPlaceholder(observation: {
  id: string;
  toolName: string;
  originalText: string;
  originalBytes: number;
  originalLines: number;
  estimatedTokens: number;
  fullSends: number;
}): string {
  const head = excerptLines(observation.originalText, "head", OBSERVATION_EXCERPT_BYTES);
  const tail = excerptLines(observation.originalText, "tail", OBSERVATION_EXCERPT_BYTES);
  const omitted = observation.originalBytes - utf8Bytes(head) - utf8Bytes(tail);
  return [
    `${OBSERVATION_PLACEHOLDER_MARKER} large tool result replaced]`,
    `id: ${observation.id}`,
    `tool: ${observation.toolName}`,
    `original_bytes: ${observation.originalBytes}`,
    `original_lines: ${observation.originalLines}`,
    `estimated_tokens: ${observation.estimatedTokens}`,
    `This result was sent in full for the first ${observation.fullSends} provider requests; later requests see this placeholder only.`,
    `Use ObsRecall with {"id":"${observation.id}","offset":0} to page through the original bytes; continue with next_offset until eof.`,
    "---- head ----",
    head,
    `---- ${omitted > 0 ? omitted : 0} bytes omitted ----`,
    "---- tail ----",
    tail,
  ].join("\n");
}
