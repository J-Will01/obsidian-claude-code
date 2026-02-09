import { ChatMessage, ToolCall } from "../types";

type ToolInputBuffer = {
  id: string;
  name: string;
  inputJson: string;
};

type StreamingState = {
  text: string;
  toolCalls: Map<string, ToolCall>;
  toolCallIndex: Map<number, string>;
  toolInputs: Map<string, ToolInputBuffer>;
  lastEmitAt: number;
};

const DEFAULT_THROTTLE_MS = 80;

export class StreamingAccumulator {
  private states = new Map<string, StreamingState>();
  private throttleMs: number;

  constructor(throttleMs: number = DEFAULT_THROTTLE_MS) {
    this.throttleMs = throttleMs;
  }

  updateFromStreamEvent(
    messageId: string,
    event: any,
    now = Date.now()
  ): ChatMessage | null {
    const state = this.ensureState(messageId);
    let changed = false;

    if (event?.type === "content_block_start") {
      const block = event.content_block;
      if (block?.type === "text") {
        // No-op on start.
      } else if (block?.type === "tool_use" || block?.type === "server_tool_use" || block?.type === "mcp_tool_use") {
        const toolCall: ToolCall = {
          id: block.id,
          name: block.name ?? block.tool_name ?? "tool",
          input: (block.input as Record<string, unknown>) || {},
          status: "running",
          startTime: now,
        };
        state.toolCalls.set(toolCall.id, toolCall);
        if (typeof event.index === "number") {
          state.toolCallIndex.set(event.index, toolCall.id);
        }
        state.toolInputs.set(toolCall.id, { id: toolCall.id, name: toolCall.name, inputJson: "" });
        changed = true;
      }
    }

    if (event?.type === "content_block_delta") {
      const delta = event.delta;
      if (delta?.type === "text_delta") {
        state.text += delta.text ?? "";
        changed = true;
      } else if (delta?.type === "input_json_delta") {
        const toolId = typeof event.index === "number" ? state.toolCallIndex.get(event.index) : undefined;
        if (toolId) {
          const buffer = state.toolInputs.get(toolId);
          if (buffer) {
            buffer.inputJson += delta.partial_json ?? "";
            try {
              if (buffer.inputJson.trim()) {
                const parsed = JSON.parse(buffer.inputJson);
                const toolCall = state.toolCalls.get(toolId);
                if (toolCall) {
                  toolCall.input = parsed;
                  changed = true;
                }
              }
            } catch {
              // Ignore partial JSON parse errors.
            }
          }
        }
      }
    }

    if (!changed) return null;
    if (now - state.lastEmitAt < this.throttleMs) return null;
    state.lastEmitAt = now;
    return this.buildMessage(messageId, state, true, now);
  }

  finalize(
    messageId: string,
    finalText: string | null,
    toolCalls: ToolCall[],
    now = Date.now()
  ): ChatMessage {
    const state = this.ensureState(messageId);
    if (finalText !== null && finalText !== undefined) {
      state.text = finalText;
    }
    for (const toolCall of toolCalls) {
      state.toolCalls.set(toolCall.id, toolCall);
    }
    const message = this.buildMessage(messageId, state, false, now);
    this.states.delete(messageId);
    return message;
  }

  getState(messageId: string): StreamingState | undefined {
    return this.states.get(messageId);
  }

  private ensureState(messageId: string): StreamingState {
    let state = this.states.get(messageId);
    if (!state) {
      state = {
        text: "",
        toolCalls: new Map(),
        toolCallIndex: new Map(),
        toolInputs: new Map(),
        lastEmitAt: 0,
      };
      this.states.set(messageId, state);
    }
    return state;
  }

  private buildMessage(messageId: string, state: StreamingState, isStreaming: boolean, now: number): ChatMessage {
    return {
      id: messageId,
      role: "assistant",
      content: state.text,
      timestamp: now,
      toolCalls: state.toolCalls.size > 0 ? Array.from(state.toolCalls.values()) : undefined,
      isStreaming,
    };
  }
}
