import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  WorkflowChunk,
  WorkflowMessage,
  ToolDef,
  ToolCallDelta,
} from "../types/workflow";

/** Accumulated result from a streaming LLM call */
export interface StreamResult {
  thinking: string;
  content: string;
  toolCalls: { id: string; name: string; arguments: string }[];
}

/**
 * Stream chat completions with optional tool calling.
 * Supports provider-normalized deltas:
 *   - thinking_delta: DeepSeek R1 reasoning / Anthropic thinking
 *   - content_delta:  response text (all providers)
 *   - tool_call_delta: function calls
 */
/**
 * Tool-choice values passed verbatim to the OpenAI-compatible API.
 *   "auto"      — model decides (default when tools are present)
 *   "required"  — model MUST call at least one tool
 *   "none"      — model MUST NOT call tools
 *   { type:"function", function:{ name:"x" } } — force specific tool
 */
export type ToolChoice =
  | "auto"
  | "required"
  | "none"
  | { type: "function"; function: { name: string } };

export async function chatStreamWithTools(
  providerId: string,
  model: string,
  messages: WorkflowMessage[],
  tools: ToolDef[] | null,
  callbacks?: {
    onThinkingDelta?: (delta: string) => void;
    onContentDelta?: (delta: string) => void;
    // Fires on each tool-call argument fragment as it streams from the API.
    // Use this to progressively reveal structured outputs (e.g. extract a
    // `"thinking":"…"` field or partial plan sections) so the UI doesn't
    // block waiting for the full tool call to complete.
    //   toolIndex   — which tool call in the response (0 = first)
    //   toolName    — function name once known ("" until server sends it)
    //   argsSoFar   — full accumulated arguments string up to & including fragment
    //   fragment    — the just-arrived chunk
    onToolArgsDelta?: (info: {
      toolIndex: number;
      toolName: string;
      argsSoFar: string;
      fragment: string;
    }) => void;
  },
  toolChoice?: ToolChoice
): Promise<StreamResult> {
  const channel = new Channel<WorkflowChunk>();

  let thinking = "";
  let content = "";
  const tcFrags: Record<number, { id: string; name: string; args: string }> =
    {};

  return new Promise((resolve, reject) => {
    channel.onmessage = (chunk: WorkflowChunk) => {
      if (chunk.error) {
        reject(new Error(chunk.error));
        return;
      }

      if (chunk.thinking_delta) {
        thinking += chunk.thinking_delta;
        callbacks?.onThinkingDelta?.(chunk.thinking_delta);
      }

      if (chunk.content_delta) {
        content += chunk.content_delta;
        callbacks?.onContentDelta?.(chunk.content_delta);
      }

      if (chunk.tool_call_delta) {
        const d: ToolCallDelta = chunk.tool_call_delta;
        const idx = d.index;
        if (!tcFrags[idx]) {
          tcFrags[idx] = { id: "", name: "", args: "" };
        }
        if (d.id) tcFrags[idx].id = d.id;
        if (d.name) tcFrags[idx].name = d.name;
        const frag = d.arguments_fragment || "";
        tcFrags[idx].args += frag;
        if (callbacks?.onToolArgsDelta && frag) {
          callbacks.onToolArgsDelta({
            toolIndex: idx,
            toolName: tcFrags[idx].name,
            argsSoFar: tcFrags[idx].args,
            fragment: frag,
          });
        }
      }

      if (chunk.done) {
        const toolCalls = Object.values(tcFrags).map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.args,
        }));
        resolve({ thinking, content, toolCalls });
      }
    };

    invoke("chat_stream_with_tools", {
      providerId,
      model,
      messages,
      tools: tools ?? null,
      toolChoice: toolChoice ?? null,
      channel,
    }).catch((e) => {
      console.error("[workflow-llm] invoke error:", e);
      reject(e);
    });
  });
}
