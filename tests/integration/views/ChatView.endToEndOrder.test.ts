import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

import { MarkdownRenderer, MockWorkspaceLeaf } from "obsidian";

import type { ToolCall } from "@/types";
import { MessageList } from "@/views/MessageList";
import { ChatView } from "@/views/ChatView";
import { click, waitForText } from "../../helpers/dom";
import { createMockPlugin } from "../../helpers/factories";
import {
  MockQueryIterator,
  createAssistantMessage,
  createErrorResultMessage,
  createSuccessResultMessage,
  createSystemInitMessage,
  createToolUseMessage,
  query as mockQuery,
  type SDKMessage,
} from "../../mocks/claude-sdk";

type RenderedMessage = {
  role: "user" | "assistant";
  content: string;
  toolNames: string[];
};

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function readRenderedMessages(container: HTMLElement): RenderedMessage[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".claude-code-message")).map((messageEl) => {
    const role = messageEl.classList.contains("claude-code-message-user") ? "user" : "assistant";
    const content = normalizeText(
      messageEl.querySelector<HTMLElement>(".claude-code-message-content")?.textContent ?? ""
    );
    const toolNames = Array.from(
      messageEl.querySelectorAll<HTMLElement>(".claude-code-tool-call-name")
    ).map((node) => normalizeText(node.textContent ?? ""));

    return { role, content, toolNames };
  });
}

function patchMarkdownRenderer() {
  (MarkdownRenderer.render as unknown as Mock).mockImplementation(async (...args: unknown[]) => {
    const hasAppArg = typeof args[0] !== "string";
    const markdown = String(hasAppArg ? args[1] ?? "" : args[0] ?? "");
    const target = (hasAppArg ? args[2] : args[1]) as HTMLElement;

    const div = document.createElement("div");
    div.classList.add("markdown-rendered");
    div.textContent = markdown;
    target.appendChild(div);
  });
}

function createHarness(queryMessages: SDKMessage[]) {
  const plugin = createMockPlugin();
  const leaf = new MockWorkspaceLeaf() as any;
  leaf.app = plugin.app;

  const view = new ChatView(leaf, plugin as any) as any;
  const messagesContainerEl = document.createElement("div");
  document.body.appendChild(messagesContainerEl);

  view.messagesContainerEl = messagesContainerEl;
  view.messageList = new MessageList(messagesContainerEl, plugin as any);
  view.messages = [];
  view.chatInput = {
    updateState: vi.fn(),
    setHints: vi.fn(),
  };
  view.refreshProjectControls = vi.fn();
  view.isNearBottom = vi.fn().mockReturnValue(false);
  view.scrollToBottom = vi.fn();

  const currentConversation = { id: "conv-ui-order" };
  view.conversationManager = {
    addMessage: vi.fn().mockResolvedValue(undefined),
    getCurrentConversation: vi.fn(() => currentConversation),
    addMessageToConversation: vi.fn().mockResolvedValue(undefined),
    updateUsageForConversation: vi.fn().mockResolvedValue(undefined),
    updateSessionIdForConversation: vi.fn().mockResolvedValue(undefined),
    getPinnedContext: vi.fn(() => []),
  };

  (mockQuery as unknown as Mock).mockImplementation(() => new MockQueryIterator(queryMessages));

  return {
    view,
    messagesContainerEl,
    conversationManager: view.conversationManager,
  };
}

function createHarnessWithSequences(querySequences: SDKMessage[][]) {
  const plugin = createMockPlugin();
  const leaf = new MockWorkspaceLeaf() as any;
  leaf.app = plugin.app;

  const view = new ChatView(leaf, plugin as any) as any;
  const messagesContainerEl = document.createElement("div");
  document.body.appendChild(messagesContainerEl);

  view.messagesContainerEl = messagesContainerEl;
  view.messageList = new MessageList(messagesContainerEl, plugin as any);
  view.messages = [];
  view.chatInput = {
    updateState: vi.fn(),
    setHints: vi.fn(),
  };
  view.refreshProjectControls = vi.fn();
  view.isNearBottom = vi.fn().mockReturnValue(false);
  view.scrollToBottom = vi.fn();

  const currentConversation = { id: "conv-ui-order" };
  view.conversationManager = {
    addMessage: vi.fn().mockResolvedValue(undefined),
    getCurrentConversation: vi.fn(() => currentConversation),
    addMessageToConversation: vi.fn().mockResolvedValue(undefined),
    updateUsageForConversation: vi.fn().mockResolvedValue(undefined),
    updateSessionIdForConversation: vi.fn().mockResolvedValue(undefined),
    getPinnedContext: vi.fn(() => []),
  };

  const queryMock = mockQuery as unknown as Mock;
  queryMock.mockReset();
  for (const sequence of querySequences) {
    queryMock.mockImplementationOnce(() => new MockQueryIterator(sequence));
  }

  return {
    view,
    messagesContainerEl,
    conversationManager: view.conversationManager,
  };
}

describe("ChatView end-to-end transcript rendering", () => {
  let previousNvmBin: string | undefined;

  beforeEach(() => {
    patchMarkdownRenderer();
    previousNvmBin = process.env.NVM_BIN;
    const fakeBinDir = path.join(os.tmpdir(), "obsidian-claude-code-test-bin");
    const fakeClaudePath = path.join(fakeBinDir, "claude");
    fs.mkdirSync(fakeBinDir, { recursive: true });
    if (!fs.existsSync(fakeClaudePath)) {
      fs.writeFileSync(fakeClaudePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    process.env.NVM_BIN = fakeBinDir;
  });

  afterEach(() => {
    process.env.NVM_BIN = previousNvmBin;
    vi.restoreAllMocks();
  });

  it("renders tool call before continuation text for a single tool phase", async () => {
    const messages: SDKMessage[] = [
      createSystemInitMessage("session-e2e-1"),
      createAssistantMessage("I will inspect the file first."),
      createToolUseMessage("Read", { file_path: "/notes.md" }, "tool-read-1"),
      createAssistantMessage("After reading, here is the summary."),
      createSuccessResultMessage(2, 0.02, "After reading, here is the summary."),
    ];

    const { view, messagesContainerEl } = createHarness(messages);

    await view.handleSendMessage("Summarize notes");

    const rendered = readRenderedMessages(messagesContainerEl);

    expect(rendered).toHaveLength(3);
    expect(rendered.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    expect(rendered[0].content).toBe("Summarize notes");

    expect(rendered[1].content).toContain("I will inspect the file first.");
    expect(rendered[1].toolNames).toEqual(["Read"]);
    expect(
      normalizeText(
        messagesContainerEl.querySelector<HTMLElement>(".claude-code-message-assistant .claude-code-tool-call-status")
          ?.textContent ?? ""
      )
    ).toBe("✓");

    expect(rendered[2].content).toContain("After reading, here is the summary.");
    expect(rendered[2].toolNames).toEqual([]);
  });

  it("persists streamed assistant segments in displayed order for reopen", async () => {
    const messages: SDKMessage[] = [
      createSystemInitMessage("session-e2e-persist-order"),
      createAssistantMessage("I will inspect the file first."),
      createToolUseMessage("Read", { file_path: "/notes.md" }, "tool-read-1"),
      createAssistantMessage("After reading, here is the summary."),
      createSuccessResultMessage(2, 0.02, "After reading, here is the summary."),
    ];

    const { view, conversationManager } = createHarness(messages);

    await view.handleSendMessage("Summarize notes");

    const assistantSaves = (conversationManager.addMessageToConversation as Mock).mock.calls
      .map((call: any[]) => call[1])
      .filter((message: any) => message?.role === "assistant");

    expect(assistantSaves).toHaveLength(2);
    expect(assistantSaves[0].content).toContain("I will inspect the file first.");
    expect(assistantSaves[0].toolCalls?.map((tool: ToolCall) => tool.name)).toEqual(["Read"]);
    expect(assistantSaves[1].content).toContain("After reading, here is the summary.");
    expect(assistantSaves[1].toolCalls).toBeUndefined();
  });

  it("renders multi-tool phases in visible top-to-bottom order", async () => {
    const messages: SDKMessage[] = [
      createSystemInitMessage("session-e2e-2"),
      createAssistantMessage("Let me read the comments file."),
      createToolUseMessage("Read", { file_path: "/comments.md" }, "tool-read-1"),
      createAssistantMessage("Let me read the comments file. Let me find and read the screenshots."),
      createToolUseMessage("Grep", { pattern: "TODO", path: "/" }, "tool-grep-2"),
      createAssistantMessage(
        "Let me read the comments file. Let me find and read the screenshots. Good. Now I will update the comments file."
      ),
      createSuccessResultMessage(
        3,
        0.03,
        "Let me read the comments file. Let me find and read the screenshots. Good. Now I will update the comments file."
      ),
    ];

    const { view, messagesContainerEl } = createHarness(messages);

    await view.handleSendMessage("Review notes");

    const rendered = readRenderedMessages(messagesContainerEl);

    expect(rendered).toHaveLength(4);
    expect(rendered.map((message) => message.role)).toEqual(["user", "assistant", "assistant", "assistant"]);
    expect(rendered[0].content).toBe("Review notes");

    expect(rendered[1].content).toContain("Let me read the comments file.");
    expect(rendered[1].toolNames).toEqual(["Read"]);

    expect(rendered[2].content).toContain("Let me find and read the screenshots.");
    expect(rendered[2].toolNames).toEqual(["Grep"]);

    expect(rendered[3].content).toContain("Good. Now I will update the comments file.");
    expect(rendered[3].toolNames).toEqual([]);
  });

  it("renders streamed stream_event tool/text updates in visible order", async () => {
    const messages: SDKMessage[] = [
      createSystemInitMessage("session-e2e-stream-events"),
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "I will inspect the file first." },
        },
      } as SDKMessage,
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-read-stream-1",
            name: "Read",
            input: { file_path: "/notes.md" },
          },
        },
      } as SDKMessage,
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: " After reading, here is the summary." },
        },
      } as SDKMessage,
      createSuccessResultMessage(
        2,
        0.02,
        "I will inspect the file first. After reading, here is the summary."
      ),
    ];

    const { view, messagesContainerEl } = createHarness(messages);

    await view.handleSendMessage("Summarize notes");

    const rendered = readRenderedMessages(messagesContainerEl);

    expect(rendered).toHaveLength(3);
    expect(rendered[0].content).toBe("Summarize notes");
    expect(rendered[1].content).toContain("I will inspect the file first.");
    expect(rendered[1].toolNames).toEqual(["Read"]);
    expect(rendered[2].content).toContain("After reading, here is the summary.");
    expect(rendered[2].toolNames).toEqual([]);
  });

  it("shows error UI and clears streaming placeholder on permanent failure", async () => {
    const messages: SDKMessage[] = [
      createSystemInitMessage("session-e2e-failure"),
      createAssistantMessage("Starting request."),
      createErrorResultMessage(["Permanent upstream failure"]),
    ];

    const { view, messagesContainerEl } = createHarness(messages);

    await view.handleSendMessage("Summarize notes");

    const rendered = readRenderedMessages(messagesContainerEl);
    expect(rendered).toHaveLength(1);
    expect(rendered[0].role).toBe("user");
    expect(rendered[0].content).toBe("Summarize notes");

    const errorTitle = normalizeText(
      messagesContainerEl.querySelector<HTMLElement>(".claude-code-error-title")?.textContent ?? ""
    );
    expect(errorTitle).toBe("Permanent upstream failure");
    expect(messagesContainerEl.querySelector(".claude-code-error-retry")).toBeNull();
    expect(messagesContainerEl.querySelector(".claude-code-streaming")).toBeNull();
  });

  it("retries after transient failure without duplicating user messages", async () => {
    const transientFailure: SDKMessage[] = [
      createSystemInitMessage("session-e2e-retry-1"),
      createErrorResultMessage(["timeout"]),
    ];
    const recoveryAttempt: SDKMessage[] = [
      createSystemInitMessage("session-e2e-retry-2"),
      createAssistantMessage("Recovered response"),
      createSuccessResultMessage(1, 0.01, "Recovered response"),
    ];

    const { view, messagesContainerEl } = createHarnessWithSequences([
      transientFailure,
      transientFailure,
      transientFailure,
      recoveryAttempt,
    ]);

    await view.handleSendMessage("Retry this");

    const retryButton = messagesContainerEl.querySelector<HTMLElement>(".claude-code-error-retry");
    expect(retryButton).toBeTruthy();
    click(retryButton!);

    await waitForText("Recovered response", messagesContainerEl, 1000);

    const rendered = readRenderedMessages(messagesContainerEl);
    const userMessages = rendered.filter((message) => message.role === "user" && message.content === "Retry this");

    expect(userMessages).toHaveLength(1);
    expect(rendered.some((message) => message.role === "assistant" && message.content.includes("Recovered response")))
      .toBe(true);
    expect(messagesContainerEl.querySelector(".claude-code-error")).toBeNull();
  });
});
