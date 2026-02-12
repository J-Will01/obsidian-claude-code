import { App, Modal, setIcon } from "obsidian";
import type { Conversation } from "../types";

type ResumeConversationSelect = (conversation: Conversation) => void | Promise<void>;

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

function formatRelativeTime(timestamp: number): string {
  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 60_000) return "just now";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

function formatTokenCount(tokens: number | undefined): string {
  const value = Math.max(0, Number(tokens ?? 0));
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return `${value}`;
}

export class ResumeConversationModal extends Modal {
  private conversations: Conversation[];
  private filtered: Conversation[] = [];
  private currentConversationId: string | null;
  private onSelectConversation: ResumeConversationSelect;
  private initialQuery: string;
  private searchEl!: HTMLInputElement;
  private listEl!: HTMLElement;
  private selectedIndex = 0;

  constructor(
    app: App,
    conversations: Conversation[],
    currentConversationId: string | null,
    onSelectConversation: ResumeConversationSelect,
    initialQuery = ""
  ) {
    super(app);
    this.conversations = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
    this.currentConversationId = currentConversationId;
    this.onSelectConversation = onSelectConversation;
    this.initialQuery = initialQuery;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("claude-code-resume-modal");

    const headerEl = contentEl.createDiv({ cls: "claude-code-resume-header" });
    headerEl.createEl("h2", { text: "Resume Session" });

    const searchWrap = contentEl.createDiv({ cls: "claude-code-resume-search-wrap" });
    const searchIcon = searchWrap.createSpan({ cls: "claude-code-resume-search-icon" });
    setIcon(searchIcon, "search");
    this.searchEl = searchWrap.createEl("input", {
      cls: "claude-code-resume-search",
      attr: {
        type: "text",
        placeholder: "Search conversations...",
      },
    });
    this.searchEl.value = this.initialQuery;
    this.searchEl.addEventListener("input", () => this.applyFilter());
    this.searchEl.addEventListener("keydown", (event) => this.handleKeydown(event));

    this.listEl = contentEl.createDiv({ cls: "claude-code-resume-list" });
    const footerEl = contentEl.createDiv({ cls: "claude-code-resume-footer" });
    footerEl.setText("Arrow keys to navigate · Enter to resume · Type to search · Esc to cancel");

    this.applyFilter();

    window.setTimeout(() => {
      this.searchEl.focus();
      this.searchEl.select();
    }, 0);
  }

  private applyFilter() {
    const query = normalizeSearchText(this.searchEl.value);
    this.filtered = this.conversations.filter((conversation) => {
      if (!query) return true;
      const title = normalizeSearchText(conversation.title || "");
      const id = normalizeSearchText(conversation.id);
      const session = normalizeSearchText(conversation.sessionId || "");
      return title.includes(query) || id.includes(query) || session.includes(query);
    });

    if (this.filtered.length === 0) {
      this.selectedIndex = 0;
    } else if (this.selectedIndex >= this.filtered.length) {
      this.selectedIndex = this.filtered.length - 1;
    }
    this.renderList();
  }

  private renderList() {
    this.listEl.empty();
    if (this.filtered.length === 0) {
      const emptyEl = this.listEl.createDiv({ cls: "claude-code-resume-empty" });
      emptyEl.setText("No conversations match your search.");
      return;
    }

    this.filtered.forEach((conversation, index) => {
      const itemEl = this.listEl.createDiv({ cls: "claude-code-resume-item" });
      if (index === this.selectedIndex) {
        itemEl.addClass("is-selected");
      }
      if (conversation.id === this.currentConversationId) {
        itemEl.addClass("is-current");
      }

      const titleRow = itemEl.createDiv({ cls: "claude-code-resume-title-row" });
      titleRow.createSpan({
        cls: "claude-code-resume-title",
        text: conversation.title || "Untitled",
      });
      if (conversation.id === this.currentConversationId) {
        titleRow.createSpan({ cls: "claude-code-resume-current-badge", text: "CURRENT" });
      }

      const primaryMeta = itemEl.createDiv({ cls: "claude-code-resume-meta" });
      primaryMeta.setText(
        `${formatRelativeTime(conversation.updatedAt)} · ${conversation.messageCount} messages · ${formatTokenCount(conversation.metadata?.totalTokens)} tokens · $${(conversation.metadata?.totalCostUsd ?? 0).toFixed(4)}`
      );

      const secondaryMeta = itemEl.createDiv({ cls: "claude-code-resume-meta subtle" });
      secondaryMeta.setText(conversation.id);

      itemEl.addEventListener("mouseenter", () => {
        this.selectedIndex = index;
        this.updateSelection();
      });
      itemEl.addEventListener("click", () => {
        this.selectedIndex = index;
        this.selectCurrent();
      });
    });
  }

  private handleKeydown(event: KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.moveSelection(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      this.moveSelection(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      this.selectCurrent();
    }
  }

  private moveSelection(delta: number) {
    if (this.filtered.length === 0) {
      this.selectedIndex = 0;
      return;
    }
    this.selectedIndex = (this.selectedIndex + delta + this.filtered.length) % this.filtered.length;
    this.updateSelection();
  }

  private updateSelection() {
    const items = this.listEl.querySelectorAll(".claude-code-resume-item");
    items.forEach((item, index) => {
      item.toggleClass("is-selected", index === this.selectedIndex);
    });

    const selected = items[this.selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: "nearest" });
  }

  private selectCurrent() {
    const selectedConversation = this.filtered[this.selectedIndex];
    if (!selectedConversation) return;
    void Promise.resolve(this.onSelectConversation(selectedConversation));
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}
