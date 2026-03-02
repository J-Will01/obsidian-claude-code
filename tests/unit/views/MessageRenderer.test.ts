import { describe, it, expect } from "vitest";

import type { ChatMessage, ToolCall } from "@/types";
import { MessageRenderer } from "@/views/MessageRenderer";
import { createContainer } from "../../helpers/dom";
import { createMockPlugin } from "../../helpers/factories";

function createRenderer(message: ChatMessage) {
  const container = createContainer();
  const plugin = createMockPlugin();
  const renderer = new MessageRenderer(container, message, plugin as any);
  renderer.render();
  return { container };
}

function runningTool(overrides?: Partial<ToolCall>): ToolCall {
  return {
    id: "tool-1",
    name: "Read",
    input: { file_path: "/note.md" },
    status: "running",
    startTime: Date.now(),
    ...overrides,
  };
}

describe("MessageRenderer streaming indicator", () => {
  it("shows Thinking when streaming with empty content", () => {
    const { container } = createRenderer({
      id: "msg-1",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      isStreaming: true,
    });

    expect(container.querySelector(".claude-code-streaming")).toBeTruthy();
  });

  it("hides Thinking when assistant output text is visible", () => {
    const { container } = createRenderer({
      id: "msg-2",
      role: "assistant",
      content: "Here is the first part of the answer.",
      timestamp: Date.now(),
      isStreaming: true,
      toolCalls: [runningTool()],
    });

    expect(container.querySelector(".claude-code-streaming")).toBeNull();
  });

  it("shows Thinking for empty content while a tool call is running", () => {
    const { container } = createRenderer({
      id: "msg-3",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      isStreaming: true,
      toolCalls: [runningTool()],
    });

    expect(container.querySelector(".claude-code-streaming")).toBeTruthy();
  });

  it("hides Thinking when tools are complete", () => {
    const { container } = createRenderer({
      id: "msg-4",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      isStreaming: true,
      toolCalls: [runningTool({ status: "success", endTime: Date.now() })],
    });

    expect(container.querySelector(".claude-code-streaming")).toBeNull();
  });
});
