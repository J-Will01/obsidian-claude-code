import { describe, expect, it, vi } from "vitest";

import { createMockApp } from "../../mocks/obsidian/App.mock";
import { keydown } from "../../helpers/dom";
import { ResumeConversationModal } from "../../../src/views/ResumeConversationModal";
import type { Conversation } from "../../../src/types";

function makeConversation(partial: Partial<Conversation> & Pick<Conversation, "id" | "title">): Conversation {
  const now = Date.now();
  return {
    id: partial.id,
    sessionId: partial.sessionId ?? partial.id,
    title: partial.title,
    createdAt: partial.createdAt ?? now - 60_000,
    updatedAt: partial.updatedAt ?? now,
    messageCount: partial.messageCount ?? 1,
    metadata: partial.metadata ?? {
      totalTokens: 1000,
      totalCostUsd: 0.01,
      inputTokens: 600,
      outputTokens: 400,
    },
    pinnedContext: partial.pinnedContext ?? [],
  };
}

describe("ResumeConversationModal", () => {
  it("should render recent conversations with metadata", () => {
    const app = createMockApp();
    const onSelect = vi.fn();
    const conversations: Conversation[] = [
      makeConversation({ id: "conv-1", title: "Alpha Notes", messageCount: 8 }),
      makeConversation({ id: "conv-2", title: "Beta Planning", messageCount: 14 }),
    ];

    const modal = new ResumeConversationModal(app as any, conversations, "conv-1", onSelect);
    modal.open();

    expect(modal.contentEl.textContent).toContain("Resume Session");
    expect(modal.contentEl.textContent).toContain("Alpha Notes");
    expect(modal.contentEl.textContent).toContain("Beta Planning");
    expect(modal.contentEl.textContent).toContain("messages");
  });

  it("should filter the list based on search text", () => {
    const app = createMockApp();
    const onSelect = vi.fn();
    const conversations: Conversation[] = [
      makeConversation({ id: "conv-1", title: "Alpha Notes" }),
      makeConversation({ id: "conv-2", title: "Sprint Review" }),
      makeConversation({ id: "conv-3", title: "Beta Planning" }),
    ];

    const modal = new ResumeConversationModal(app as any, conversations, null, onSelect);
    modal.open();

    const searchEl = modal.contentEl.querySelector(".claude-code-resume-search") as HTMLInputElement;
    searchEl.value = "sprint";
    searchEl.dispatchEvent(new Event("input", { bubbles: true }));

    const titles = Array.from(
      modal.contentEl.querySelectorAll(".claude-code-resume-title")
    ).map((el) => el.textContent || "");

    expect(titles).toEqual(["Sprint Review"]);
  });

  it("should support keyboard navigation and Enter selection", () => {
    const app = createMockApp();
    const onSelect = vi.fn();
    const conversations: Conversation[] = [
      makeConversation({ id: "conv-1", title: "Alpha Notes" }),
      makeConversation({ id: "conv-2", title: "Beta Planning" }),
      makeConversation({ id: "conv-3", title: "Gamma Tasks" }),
    ];

    const modal = new ResumeConversationModal(app as any, conversations, null, onSelect);
    modal.open();

    const searchEl = modal.contentEl.querySelector(".claude-code-resume-search") as HTMLInputElement;
    keydown(searchEl, "ArrowDown");
    keydown(searchEl, "Enter");

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "conv-2" }));
  });
});
