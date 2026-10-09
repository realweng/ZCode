// ============================================================
// ObsRecall Tool - 观察对象的精确分页召回
// ============================================================
// 与 ObservationPack 占位符配套：占位符携带稳定 id，模型按 offset 顺序翻页原文。
// 只读、无审批；端口缺席（功能未开启）时报能力缺口而不是静默空结果。
// 注册门：registerBuiltInTools 的 includeObservationRecall（features.observationPack）。

import type { ModelMessageContent } from "@zcode/contracts";
import type { ToolEntry, ToolHandler, ToolHandlerFailure } from "../../tool/types.js";
import { OBSERVATION_RECALL_MAX_BYTES } from "./types.js";

export const OBS_RECALL_TOOL_NAME = "ObsRecall";

const OBS_RECALL_TIMEOUT_MS = 15_000;
/** 单页 16 KiB + 头部行；预算给到 20k 让 eof 页也完整内联。 */
const OBS_RECALL_MODEL_BYTES = 20_000;

const OBS_RECALL_ERROR_CODE = { PORT_UNAVAILABLE: 41 } as const;

const OBS_RECALL_DESCRIPTION = [
  "Pages through the original bytes of a large tool result that was replaced by an ObservationPack placeholder.",
  "",
  "- `id` comes from the placeholder block (line `id: obs_...`).",
  "- Start with `offset: 0`, then continue with the returned `next_offset` until `eof: true`.",
  "- Each page returns up to 16 KiB / 400 lines of the exact original text.",
].join("\n");

const OBS_RECALL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Observation id from the placeholder (obs_...)" },
    offset: {
      type: "integer",
      minimum: 0,
      description: "Byte offset to resume from; omit for 0",
    },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

const OBS_RECALL_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    text: { type: "string" },
    offset: { type: "integer" },
    next_offset: { type: "integer" },
    eof: { type: "boolean" },
  },
  required: ["id", "text", "offset", "next_offset", "eof"],
  additionalProperties: false,
} as const;

function obsRecallPortUnavailableFailure(): ToolHandlerFailure {
  return {
    result: false,
    errorCode: OBS_RECALL_ERROR_CODE.PORT_UNAVAILABLE,
    message:
      "observation_recall_unavailable: this session has no observation recall port — ObservationPack is not enabled, so there are no placeholders to page through. Do not call ObsRecall again.",
  };
}

const obsRecallHandler: ToolHandler = async (input, context) => {
  const port = context.observationRecallPort;
  if (port === undefined) return obsRecallPortUnavailableFailure();
  const args = input as { id: string; offset?: number };
  const recalled = await port.recall({ id: args.id, ...(args.offset === undefined ? {} : { offset: args.offset }) });
  if (recalled.result === false) {
    return {
      result: false,
      errorCode: OBS_RECALL_ERROR_CODE.PORT_UNAVAILABLE,
      message: `${recalled.reason}: ${recalled.message}`,
    };
  }
  return {
    id: recalled.id,
    text: recalled.text,
    offset: recalled.offset,
    next_offset: recalled.nextOffset,
    eof: recalled.eof,
  };
};

function formatObsRecallModelContent(output: unknown): ModelMessageContent {
  const parsed = output as { id?: string; text?: string; next_offset?: number; eof?: boolean };
  if (typeof parsed?.text !== "string" || typeof parsed.next_offset !== "number") {
    return "ObsRecall returned an invalid result.";
  }
  return [
    `<observation id="${parsed.id ?? "unknown"}" next_offset="${parsed.next_offset}" eof="${parsed.eof === true}">`,
    parsed.text,
    "</observation>",
  ].join("\n");
}

export const obsRecallToolEntry: ToolEntry = {
  capability: "Page through the original bytes of an ObservationPack placeholder by stable id",
  metadata: {
    name: OBS_RECALL_TOOL_NAME,
    description: OBS_RECALL_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: OBS_RECALL_TIMEOUT_MS,
    maxOutputBytes: OBS_RECALL_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: obsRecallHandler,
  inputSchema: OBS_RECALL_INPUT_SCHEMA,
  outputSchema: OBS_RECALL_OUTPUT_SCHEMA,
  formatModelContent: formatObsRecallModelContent,
  permission: {
    permission: "observationRecall",
    reason: "ObsRecall reads session-archived tool results referenced by ObservationPack placeholders",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: OBS_RECALL_MODEL_BYTES,
    maxModelBytes: OBS_RECALL_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: OBS_RECALL_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    kind: "timed",
    defaultMs: OBS_RECALL_TIMEOUT_MS,
    maxMs: OBS_RECALL_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage: "ObsRecall reads an archived observation and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

/** 单页上限导出给测试对齐断言。 */
export const OBS_RECALL_PAGE_LIMIT_BYTES = OBSERVATION_RECALL_MAX_BYTES;
