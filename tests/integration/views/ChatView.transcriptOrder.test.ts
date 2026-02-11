import { describe, expect, it, vi } from "vitest";
import { MockWorkspaceLeaf } from "obsidian";

import type { ChatMessage, ToolCall } from "@/types";
import { ChatView } from "@/views/ChatView";
import { createMockPlugin } from "../../helpers/factories";

type ChatViewTestHarness = ChatView & {
  messages: ChatMessage[];
  messageList: {
    addMessage: ReturnType<typeof vi.fn>;
    updateMessage: ReturnType<typeof vi.fn>;
    render: ReturnType<typeof vi.fn>;
  };
  messagesContainerEl: HTMLElement;
  streamingMessageId: string | null;
  streamingTextMessageId: string | null;
  streamingBaseContentPrefix: string | null;
  activeStreamConversationId: string | null;
  conversationManager: { getCurrentConversation: () => { id: string } | null };
  handleStreamingMessage: (message: ChatMessage) => void;
  handleToolCall: (toolCall: ToolCall) => void;
  isNearBottom: () => boolean;
  scrollToBottom: () => void;
};

function createStreamingViewHarness(): ChatViewTestHarness {
  const plugin = createMockPlugin() as any;
  const leaf = new MockWorkspaceLeaf() as any;
  leaf.app = plugin.app;

  const view = new ChatView(leaf, plugin) as ChatViewTestHarness;
  view.messagesContainerEl = document.createElement("div");
  view.messageList = {
    addMessage: vi.fn(),
    updateMessage: vi.fn(),
    render: vi.fn(),
  };
  view.messages = [];
  view.activeStreamConversationId = "conv-1";
  view.conversationManager = {
    getCurrentConversation: () => ({ id: "conv-1" }),
  };

  vi.spyOn(view, "isNearBottom").mockReturnValue(false);
  vi.spyOn(view, "scrollToBottom").mockImplementation(() => {});

  return view;
}

function createToolCall(id: string): ToolCall {
  return {
    id,
    name: "WebSearch",
    input: { query: "teams vs slack" },
    status: "running",
    startTime: Date.now(),
  };
}

describe("ChatView transcript ordering", () => {
  it("keeps tool call before text when tool appears before first streamed text chunk", () => {
    const view = createStreamingViewHarness();
    const baseId = "stream-base";
    const toolCall = createToolCall("tool-1");

    view.messages.push({
      id: baseId,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      isStreaming: true,
    });
    view.streamingMessageId = baseId;
    view.streamingTextMessageId = baseId;
    view.streamingBaseContentPrefix = null;

    view.handleToolCall(toolCall);
    view.handleStreamingMessage({
      id: baseId,
      role: "assistant",
      content: "Pulling references now.",
      timestamp: Date.now(),
      toolCalls: [toolCall],
      isStreaming: true,
    });

    expect(view.messages).toHaveLength(2);
    expect(view.messages[0].id).toBe(baseId);
    expect(view.messages[0].content).toBe("");
    expect(view.messages[0].toolCalls?.[0]?.id).toBe("tool-1");
    expect(view.messages[1].role).toBe("assistant");
    expect(view.messages[1].content).toContain("Pulling references now.");
    expect(view.streamingTextMessageId).not.toBe(baseId);
  });

  it("preserves pre-tool text and appends post-tool text below the tool call", () => {
    const view = createStreamingViewHarness();
    const baseId = "stream-base";
    const toolCall = createToolCall("tool-2");

    view.messages.push({
      id: baseId,
      role: "assistant",
      content: "I can look this up.",
      timestamp: Date.now(),
      isStreaming: true,
    });
    view.streamingMessageId = baseId;
    view.streamingTextMessageId = baseId;
    view.streamingBaseContentPrefix = null;

    view.handleToolCall(toolCall);
    view.handleStreamingMessage({
      id: baseId,
      role: "assistant",
      content: "I can look this up. Here are the first findings.",
      timestamp: Date.now(),
      toolCalls: [toolCall],
      isStreaming: true,
    });

    expect(view.messages).toHaveLength(2);
    expect(view.messages[0].content).toBe("I can look this up.");
    expect(view.messages[0].toolCalls?.[0]?.id).toBe("tool-2");
    expect(view.messages[1].content).toContain("Here are the first findings.");

    view.handleStreamingMessage({
      id: baseId,
      role: "assistant",
      content: "I can look this up. Here are the first findings. More detail from sources.",
      timestamp: Date.now(),
      toolCalls: [toolCall],
      isStreaming: true,
    });

    expect(view.messages[0].content).toBe("I can look this up.");
    expect(view.messages[1].content).toContain("More detail from sources.");
  });
});
