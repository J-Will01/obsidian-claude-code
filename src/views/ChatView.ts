import { ItemView, WorkspaceLeaf, setIcon, Menu, ViewStateResult, Notice, MarkdownView } from "obsidian";
import { CHAT_VIEW_TYPE, ChatMessage, ToolCall, Conversation, ErrorType } from "../types";
import type ClaudeCodePlugin from "../main";
import { ChatInput, type ChatInputHint } from "./ChatInput";
import { MessageList } from "./MessageList";
import { AgentController, classifyError } from "../agent/AgentController";
import { ConversationManager } from "../agent/ConversationManager";
import { ConversationHistoryModal } from "./ConversationHistoryModal";
import { ResumeConversationModal } from "./ResumeConversationModal";
import { logger } from "../utils/Logger";
import { CLAUDE_ICON_NAME } from "../utils/icons";
import { revertFromBackup } from "../utils/DiffEngine";
import { computeContextUsageEstimate } from "../utils/contextUsage";
import type { Suggestion } from "../utils/autocomplete";
import { mergeStreamingText } from "../utils/streamingText";
import {
  getExternalSlashCommandOrigin,
  getExternalSlashCommandSuggestions,
  getSlashCommands,
  normalizeSlashCommandName,
} from "../utils/slashCommands";
import { buildContextualHints } from "../utils/hints";

export class ChatView extends ItemView {
  plugin: ClaudeCodePlugin;
  private headerEl!: HTMLElement;
  private telemetryEl: HTMLElement | null = null;
  private messagesContainerEl!: HTMLElement;
  private inputContainerEl!: HTMLElement;
  private messageList!: MessageList;
  private chatInput!: ChatInput;
  private messages: ChatMessage[] = [];
  private isStreaming = false;
  private agentController: AgentController;
  private conversationManager: ConversationManager;
  private streamingMessageId: string | null = null;
  private streamingTextMessageId: string | null = null;
  private streamingBaseContentPrefix: string | null = null;
  private streamingSegmentIds: string[] = [];
  private viewId: string;
  private isCancelling = false;  // Flag to suppress error display during intentional cancel.
  private activeStreamConversationId: string | null = null;  // Track which conversation owns the active stream.
  private lastUserMessage: string | null = null;  // Store last message for retry functionality.
  private telemetryIntervalId: number | null = null;
  private isRenamingConversationTitle = false;
  private dismissedHintIds = new Set<string>();
  private hintLastShownAt = new Map<string, number>();
  private visibleHintIds = new Set<string>();
  private latestHintMetrics: { contextPercentUsed: number; usagePercentUsed: number | null } | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudeCodePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.viewId = this.generateViewId();
    this.agentController = new AgentController(plugin);
    this.conversationManager = new ConversationManager(plugin);
    this.setupAgentEvents();
  }

  private generateViewId(): string {
    return `view-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  private setupAgentEvents() {
    this.agentController.setEventHandlers({
      onMessage: (message) => this.handleStreamingMessage(message),
      onToolCall: (toolCall) => this.handleToolCall(toolCall),
      onToolResult: (id, result, isError) => this.handleToolResult(id, result, isError),
      onStreamingStart: () => this.handleStreamingStart(),
      onStreamingEnd: () => this.handleStreamingEnd(),
      onError: (error) => this.handleError(error),

      // Subagent lifecycle events.
      onSubagentStart: (toolCallId, subagentType, subagentId) =>
        this.handleSubagentStart(toolCallId, subagentType, subagentId),
      onSubagentStop: (toolCallId, success, error) =>
        this.handleSubagentStop(toolCallId, success, error),
    });
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    const conv = this.conversationManager?.getCurrentConversation();
    if (conv && conv.title && conv.title !== "New Conversation") {
      // Truncate long titles for tab display.
      const maxLen = 20;
      const title = conv.title.length > maxLen ? conv.title.slice(0, maxLen) + "..." : conv.title;
      return `Claude: ${title}`;
    }
    return "Claude Code";
  }

  getIcon(): string {
    return CLAUDE_ICON_NAME;
  }

  // Save view state for persistence across restarts.
  getState(): { conversationId?: string } {
    return {
      conversationId: this.conversationManager?.getCurrentConversation()?.id,
    };
  }

  // Restore view state after restart.
  async setState(state: { conversationId?: string }, result: ViewStateResult): Promise<void> {
    if (state.conversationId) {
      // Will be loaded in onOpen after initialization.
      (this as any).pendingConversationId = state.conversationId;
    }
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("claude-code-view");

    // Initialize conversation manager.
    await this.conversationManager.initialize();

    // Check for pending conversation ID from state restoration.
    const pendingId = (this as any).pendingConversationId;
    if (pendingId) {
      const conv = await this.conversationManager.loadConversation(pendingId);
      if (conv) {
        this.messages = this.conversationManager.getDisplayMessages();
        if (conv.sessionId) {
          this.agentController.setSessionId(conv.sessionId);
        }
      }
      delete (this as any).pendingConversationId;
    } else {
      // Load last conversation if any.
      const conversations = await this.conversationManager.getConversations();
      if (conversations.length > 0 && this.conversationManager.getCurrentConversation()) {
        this.messages = this.conversationManager.getDisplayMessages();
        // Restore session ID if available.
        const currentConv = this.conversationManager.getCurrentConversation();
        if (currentConv?.sessionId) {
          this.agentController.setSessionId(currentConv.sessionId);
        }
      }
    }

    this.renderView();
  }

  async onClose() {
    // Cancel any streaming.
    this.agentController.cancelStream();
    if (this.telemetryIntervalId !== null) {
      window.clearInterval(this.telemetryIntervalId);
      this.telemetryIntervalId = null;
    }
  }

  private renderView() {
    // Check if API key is configured.
    if (!this.plugin.isApiKeyConfigured()) {
      this.renderSetupNotice();
      return;
    }

    this.renderHeader();
    this.renderMessagesArea();
    this.renderInputArea();
    this.renderTelemetryBars();
  }

  private renderSetupNotice() {
    const noticeEl = this.contentEl.createDiv({ cls: "claude-code-setup-notice" });

    const titleEl = noticeEl.createDiv({ cls: "claude-code-setup-notice-title" });
    titleEl.setText("Authentication Required");

    const descEl = noticeEl.createDiv();
    descEl.setText("Please configure an API key or Claude OAuth token in settings to start chatting with Claude.");

    const buttonEl = noticeEl.createEl("button", { cls: "mod-cta" });
    buttonEl.setText("Open Settings");
    buttonEl.addEventListener("click", () => {
      (this.app as any).setting.open();
      (this.app as any).setting.openTabById("obsidian-claude-code");
    });
  }

  private renderHeader() {
    this.headerEl = this.contentEl.createDiv({ cls: "claude-code-header" });

    // Title section with conversation picker.
    const titleSection = this.headerEl.createDiv({ cls: "claude-code-header-title" });
    const iconEl = titleSection.createSpan();
    setIcon(iconEl, CLAUDE_ICON_NAME);

    // Conversation picker dropdown.
    const convPicker = titleSection.createDiv({ cls: "claude-code-conv-picker" });
    const conv = this.conversationManager.getCurrentConversation();
    const titleEl = convPicker.createSpan({ cls: "claude-code-conv-title" });
    titleEl.setText(conv?.title || "New Conversation");
    const chevron = convPicker.createSpan({ cls: "claude-code-conv-chevron" });
    setIcon(chevron, "chevron-down");
    convPicker.addEventListener("click", (e) => {
      if (this.isRenamingConversationTitle) return;
      this.showConversationPicker(e);
    });
    convPicker.addEventListener("contextmenu", (e) => this.showConversationContextMenu(e));
    titleEl.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      void this.beginConversationTitleEdit();
    });

    // Actions section.
    const actionsEl = this.headerEl.createDiv({ cls: "claude-code-header-actions" });

    // New conversation button.
    const newButton = actionsEl.createEl("button", { attr: { "aria-label": "New Conversation" } });
    setIcon(newButton, "plus");
    newButton.addEventListener("click", () => this.startNewConversation());

    // Checkpoint/rewind button.
    const checkpointButton = actionsEl.createEl("button", {
      attr: { "aria-label": "Checkpoints and Rewind" },
    });
    setIcon(checkpointButton, "rotate-ccw");
    checkpointButton.addEventListener("click", (e) => this.showCheckpointMenu(e as MouseEvent));

    // Compact overflow menu for secondary actions.
    const moreButton = actionsEl.createEl("button", { attr: { "aria-label": "More Actions" } });
    setIcon(moreButton, "more-horizontal");
    moreButton.addEventListener("click", (e) => this.showHeaderActionsMenu(e));
  }

  private addNewWindowMenuItems(menu: Menu) {
    const currentCount = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE).length;
    const maxWindows = 5;

    if (currentCount >= maxWindows) {
      menu.addItem((item) => {
        item.setTitle(`Max ${maxWindows} windows reached`)
          .setDisabled(true);
      });
    } else {
      menu.addItem((item) => {
        item.setTitle(`New tab (${currentCount}/${maxWindows})`)
          .setIcon("layout-list")
          .onClick(() => this.plugin.createNewChatView("tab"));
      });

      menu.addItem((item) => {
        item.setTitle("Split right")
          .setIcon("separator-vertical")
          .onClick(() => this.plugin.createNewChatView("split-right"));
      });

      menu.addItem((item) => {
        item.setTitle("Split down")
          .setIcon("separator-horizontal")
          .onClick(() => this.plugin.createNewChatView("split-down"));
      });
    }
  }

  private showHeaderActionsMenu(e: MouseEvent) {
    const menu = new Menu();
    this.addNewWindowMenuItems(menu);
    menu.addSeparator();
    menu.addItem((item) => {
      item.setTitle("View all history")
        .setIcon("history")
        .onClick(() => {
          void this.showHistory();
        });
    });
    menu.addItem((item) => {
      item.setTitle("Rename conversation")
        .setIcon("pencil")
        .onClick(() => {
          void this.beginConversationTitleEdit();
        });
    });
    menu.addItem((item) => {
      item.setTitle("Plugin settings")
        .setIcon("settings")
        .onClick(() => this.openPluginSettings());
    });
    menu.showAtMouseEvent(e);
  }

  private openPluginSettings() {
    (this.app as any).setting.open();
    (this.app as any).setting.openTabById("obsidian-claude-code");
  }

  private showConversationContextMenu(e: MouseEvent) {
    e.preventDefault();
    const menu = new Menu();
    menu.addItem((item) => {
      item.setTitle("Rename conversation")
        .setIcon("pencil")
        .onClick(() => {
          void this.beginConversationTitleEdit();
        });
    });
    menu.addItem((item) => {
      item.setTitle("View all history")
        .setIcon("history")
        .onClick(() => {
          void this.showHistory();
        });
    });
    menu.showAtMouseEvent(e);
  }

  private async beginConversationTitleEdit() {
    if (this.isRenamingConversationTitle) return;
    const conv = this.conversationManager.getCurrentConversation();
    if (!conv) return;

    const convPicker = this.headerEl.querySelector(".claude-code-conv-picker") as HTMLElement | null;
    const titleEl = this.headerEl.querySelector(".claude-code-conv-title") as HTMLElement | null;
    if (!convPicker || !titleEl) return;

    this.isRenamingConversationTitle = true;
    const originalTitle = conv.title || "New Conversation";
    const inputEl = convPicker.createEl("input", {
      cls: "claude-code-conv-title-input",
      attr: { type: "text", "aria-label": "Conversation title" },
    });
    inputEl.value = originalTitle;
    titleEl.replaceWith(inputEl);

    const finish = async (save: boolean) => {
      if (!this.isRenamingConversationTitle) return;
      this.isRenamingConversationTitle = false;

      let nextTitle = originalTitle;
      if (save) {
        const trimmed = inputEl.value.trim();
        if (trimmed.length > 0) {
          nextTitle = trimmed;
          if (trimmed !== originalTitle && conv.id) {
            await this.conversationManager.renameConversation(conv.id, trimmed);
            (this.leaf as any).updateHeader?.();
          }
        }
      }

      const replacement = convPicker.createSpan({ cls: "claude-code-conv-title", text: nextTitle });
      inputEl.replaceWith(replacement);
      replacement.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        void this.beginConversationTitleEdit();
      });
      this.updateConversationDisplay();
    };

    inputEl.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        void finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        void finish(false);
      }
    });
    inputEl.addEventListener("click", (event) => event.stopPropagation());
    inputEl.addEventListener("blur", () => {
      void finish(true);
    });
    inputEl.focus();
    inputEl.select();
  }

  private async showConversationPicker(e: MouseEvent) {
    const menu = new Menu();
    const conversations = await this.conversationManager.getConversations();
    const currentId = this.conversationManager.getCurrentConversation()?.id;

    // List recent conversations (limit to 10).
    const recent = conversations.slice(0, 10);
    for (const conv of recent) {
      menu.addItem((item) => {
        item.setTitle(conv.title || "Untitled")
          .setIcon(conv.id === currentId ? "check" : "message-square")
          .onClick(async () => {
            await this.loadConversation(conv.id);
          });
      });
    }

    if (recent.length > 0) {
      menu.addSeparator();
    }

    menu.addItem((item) => {
      item.setTitle("New conversation")
        .setIcon("plus")
        .onClick(() => this.startNewConversation());
    });

    menu.addItem((item) => {
      item.setTitle("Rename current conversation")
        .setIcon("pencil")
        .onClick(() => {
          void this.beginConversationTitleEdit();
        });
    });

    menu.addItem((item) => {
      item.setTitle("View all history...")
        .setIcon("history")
        .onClick(() => this.showHistory());
    });

    menu.showAtMouseEvent(e);
  }

  private async loadConversation(id: string) {
    logger.info("ChatView", "loadConversation called", { id, viewId: this.viewId });

    // DON'T cancel the stream - let it complete in background.
    // The activeStreamConversationId tracks which conversation owns the stream.
    // When switching, we just clear UI state but the stream continues.

    // Clear UI streaming state (but stream continues in background).
    this.clearStreamingSegmentation();
    this.isStreaming = false;

    const conv = await this.conversationManager.loadConversation(id);
    logger.info("ChatView", "loadConversation result", {
      found: !!conv,
      messageCount: conv?.messageCount,
      displayMessageCount: conv ? this.conversationManager.getDisplayMessages().length : 0,
      sessionId: conv?.sessionId,
    });

    if (conv) {
      this.messages = this.conversationManager.getDisplayMessages();
      if (conv.sessionId) {
        this.agentController.setSessionId(conv.sessionId);
      }
      this.messagesContainerEl.empty();
      this.messageList = new MessageList(this.messagesContainerEl, this.plugin);
      if (this.messages.length === 0) {
        this.renderEmptyState();
      } else {
        this.messageList.render(this.messages);
        this.scrollToBottom();
      }
      // Update tab title and header.
      (this.leaf as any).updateHeader?.();
      this.updateConversationDisplay();
      this.refreshProjectControls();
      logger.info("ChatView", "loadConversation rendered", { messageCount: this.messages.length });
    } else {
      logger.error("ChatView", "loadConversation failed - conversation not found", { id });
    }

    this.chatInput.updateState();
  }

  private updateConversationDisplay() {
    // Update the conversation title in the header.
    const titleEl = this.headerEl.querySelector(".claude-code-conv-title");
    if (titleEl) {
      const conv = this.conversationManager.getCurrentConversation();
      titleEl.textContent = conv?.title || "New Conversation";
    }
    this.updateTelemetryBars();
  }

  private refreshProjectControls() {
    this.updateTelemetryBars();
  }

  private renderTelemetryBars() {
    this.telemetryEl?.remove();
    this.telemetryEl = this.contentEl.createDiv({ cls: "claude-code-telemetry-bars" });
    const telemetryInline = this.telemetryEl.createDiv({ cls: "claude-code-telemetry-inline" });

    const usageSegment = telemetryInline.createDiv({ cls: "claude-code-telemetry-segment" });
    usageSegment.createDiv({ cls: "claude-code-telemetry-inline-label", text: "5H" });
    const usageTrack = usageSegment.createDiv({ cls: "claude-code-telemetry-track" });
    usageTrack.createDiv({ cls: "claude-code-telemetry-fill claude-code-usage-fill" });
    usageSegment.createDiv({ cls: "claude-code-telemetry-value claude-code-usage-value" });

    telemetryInline.createDiv({ cls: "claude-code-telemetry-divider", text: "|" });

    const contextSegment = telemetryInline.createDiv({ cls: "claude-code-telemetry-segment" });
    contextSegment.createDiv({ cls: "claude-code-telemetry-inline-label", text: "context" });
    const contextTrack = contextSegment.createDiv({ cls: "claude-code-telemetry-track" });
    contextTrack.createDiv({ cls: "claude-code-telemetry-fill claude-code-context-fill" });
    contextSegment.createDiv({ cls: "claude-code-telemetry-value claude-code-context-value" });

    const metaRow = this.telemetryEl.createDiv({ cls: "claude-code-telemetry-meta" });
    const metaInfo = metaRow.createDiv({ cls: "claude-code-telemetry-meta-info" });
    metaInfo.createDiv({ cls: "claude-code-telemetry-reset", text: "5h reset: --" });
    metaInfo.createDiv({ cls: "claude-code-telemetry-weekly-reset", text: "7d reset: --" });
    metaInfo.createDiv({ cls: "claude-code-telemetry-weekly-usage", text: "7d usage: --" });

    this.updateTelemetryBars();
    if (this.telemetryIntervalId !== null) {
      window.clearInterval(this.telemetryIntervalId);
    }
    this.telemetryIntervalId = window.setInterval(() => this.updateTelemetryBars(), 30000);
  }

  private getModelContextWindow(model: string): number {
    switch ((model || "").toLowerCase()) {
      case "haiku":
      case "opus":
      case "sonnet":
      default:
        return 200000;
    }
  }

  private updateTelemetryBars() {
    if (!this.telemetryEl) return;

    const usageFill = this.telemetryEl.querySelector(".claude-code-usage-fill") as HTMLElement | null;
    const usageValue = this.telemetryEl.querySelector(".claude-code-usage-value") as HTMLElement | null;
    const contextFill = this.telemetryEl.querySelector(".claude-code-context-fill") as HTMLElement | null;
    const contextValue = this.telemetryEl.querySelector(".claude-code-context-value") as HTMLElement | null;
    const resetEl = this.telemetryEl.querySelector(".claude-code-telemetry-reset") as HTMLElement | null;
    const weeklyResetEl = this.telemetryEl.querySelector(".claude-code-telemetry-weekly-reset") as HTMLElement | null;
    const weeklyUsageEl = this.telemetryEl.querySelector(".claude-code-telemetry-weekly-usage") as HTMLElement | null;
    if (!usageFill || !usageValue || !contextFill || !contextValue || !resetEl || !weeklyResetEl || !weeklyUsageEl) return;

    const source = this.plugin.settings.usageTelemetrySource || "auto";
    if (source !== "budget") {
      void this.plugin.refreshClaudeAiPlanUsageIfStale(30000).then((updated) => {
        if (updated) {
          this.updateTelemetryBars();
        }
      });
    }

    const snapshot = this.plugin.getClaudeAiPlanUsageSnapshot();
    const usePlanUsage = (source === "claudeAi" || source === "auto") && !!snapshot;
    let usagePercentForHints: number | null = null;

    const formatResetCountdown = (iso?: string) => {
      if (!iso) return null;
      const dt = new Date(iso);
      if (Number.isNaN(dt.getTime())) return null;
      const deltaMs = dt.getTime() - Date.now();
      if (deltaMs <= 0) return "soon";
      const mins = Math.max(0, Math.round(deltaMs / 60000));
      if (mins < 60) return `${mins}m`;
      const hrs = Math.floor(mins / 60);
      const rem = mins % 60;
      return rem === 0 ? `${hrs}h` : `${hrs}h ${rem}m`;
    };

    const formatResetAt = (iso?: string) => {
      if (!iso) return null;
      const dt = new Date(iso);
      if (Number.isNaN(dt.getTime())) return null;
      return dt.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    };

    if (usePlanUsage && snapshot) {
      const usagePercent = Math.max(0, Math.min(100, snapshot.fiveHourUtilizationPercent));
      usagePercentForHints = usagePercent;
      usageFill.style.width = `${usagePercent}%`;
      usageValue.setText(`${usagePercent.toFixed(0)} %`);
      usageValue.removeAttribute("title");
      const resetCountdown = formatResetCountdown(snapshot.fiveHourResetsAt);
      resetEl.setText(
        !resetCountdown ? "5h reset: --" : resetCountdown === "soon" ? "5h reset: soon" : `5h reset: in ${resetCountdown}`
      );
      const weeklyResetAt = formatResetAt(snapshot.sevenDayResetsAt);
      weeklyResetEl.setText(weeklyResetAt ? `7d reset: ${weeklyResetAt}` : "7d reset: --");

      const threshold = Math.max(0, Math.min(100, this.plugin.settings.weeklyUsageAlertThresholdPercent ?? 80));
      const weeklyPercent = snapshot.sevenDayUtilizationPercent;
      const showWeekly = Number.isFinite(weeklyPercent) && (weeklyPercent as number) >= threshold;
      if (showWeekly && typeof weeklyPercent === "number") {
        const clamped = Math.max(0, Math.min(100, weeklyPercent));
        weeklyUsageEl.setText(`7d usage: ${clamped.toFixed(0)} %`);
      } else {
        weeklyUsageEl.setText("7d usage: --");
      }
    } else {
      if (source === "claudeAi") {
        const fiveHourBudget = Math.max(this.plugin.settings.fiveHourUsageBudgetUsd || 0, 0.01);
        const rolling = this.plugin.getRollingUsageSummary(5);
        const fallbackPercent = Math.min(100, (rolling.costUsd / fiveHourBudget) * 100);
        usagePercentForHints = fallbackPercent;
        usageFill.style.width = `${fallbackPercent}%`;
        usageValue.setText(`${fallbackPercent.toFixed(0)} %`);
        usageValue.setAttribute("title", `Local fallback: $${rolling.costUsd.toFixed(2)} / $${fiveHourBudget.toFixed(2)}`);
        const err = this.plugin.getClaudeAiPlanUsageError();
        resetEl.setText(err ? "5h reset: unavailable" : "5h reset: unavailable (no plan data)");
        weeklyResetEl.setText(err ? "7d reset: unavailable" : "7d reset: unavailable (no plan data)");
        weeklyUsageEl.setText(err ? "7d usage: unavailable" : "7d usage: --");
      } else {
        const fiveHourBudget = Math.max(this.plugin.settings.fiveHourUsageBudgetUsd || 0, 0.01);
        const rolling = this.plugin.getRollingUsageSummary(5);
        const usagePercent = Math.min(100, (rolling.costUsd / fiveHourBudget) * 100);
        usagePercentForHints = usagePercent;
        usageFill.style.width = `${usagePercent}%`;
        usageValue.setText(`${usagePercent.toFixed(0)} %`);
        usageValue.setAttribute("title", `$${rolling.costUsd.toFixed(2)} / $${fiveHourBudget.toFixed(2)}`);
        resetEl.setText("5h reset: --");
        weeklyResetEl.setText("7d reset: --");
        weeklyUsageEl.setText("7d usage: --");
      }
    }

    const conv = this.conversationManager.getCurrentConversation();
    const contextWindow = this.getModelContextWindow(this.plugin.settings.model);
    const contextEstimate = computeContextUsageEstimate({
      contextWindow,
      metadata: conv?.metadata,
      history: this.conversationManager.getHistory(),
      pinnedContext: this.conversationManager.getPinnedContext(),
    });
    contextFill.style.width = `${contextEstimate.percentUsed}%`;
    contextValue.setText(`${contextEstimate.percentUsed.toFixed(0)} %`);
    const sourceLabel =
      contextEstimate.source === "latestTurn"
        ? "latest turn input/cache"
        : "estimated from history/pinned context";
    contextValue.setAttribute(
      "title",
      `${contextEstimate.usedTokens.toLocaleString()} / ${contextEstimate.contextWindow.toLocaleString()} tokens (${sourceLabel})`
    );

    this.latestHintMetrics = {
      contextPercentUsed: contextEstimate.percentUsed,
      usagePercentUsed: usagePercentForHints,
    };
    this.updateContextualInputHints(
      contextEstimate.percentUsed,
      usagePercentForHints
    );
  }

  private updateContextualInputHints(contextPercentUsed: number, usagePercentUsed: number | null) {
    if (!this.chatInput) return;

    const now = Date.now();
    const approvedMcpServers = new Set(this.plugin.settings.approvedMcpServers);
    const hasPendingMcpApproval = this.plugin.settings.additionalMcpServers.some(
      (server) => server.enabled && !approvedMcpServers.has(server.name)
    );

    const candidates = buildContextualHints({
      contextPercentUsed,
      usagePercentUsed,
      permissionPromptSignals: this.getPermissionPromptSignals(now),
      hasPendingMcpApproval,
      permissionMode: this.plugin.settings.permissionMode,
    });

    const hintsToRender: ChatInputHint[] = [];
    for (const hint of candidates) {
      if (this.dismissedHintIds.has(hint.id)) {
        continue;
      }

      const isVisible = this.visibleHintIds.has(hint.id);
      const lastShownAt = this.hintLastShownAt.get(hint.id);
      if (!isVisible && lastShownAt && (now - lastShownAt) < hint.cooldownMs) {
        continue;
      }

      if (!isVisible) {
        this.hintLastShownAt.set(hint.id, now);
      }

      hintsToRender.push({
        id: hint.id,
        text: hint.text,
        command: hint.command,
        severity: hint.severity,
        onDismiss: (hintId: string) => this.handleHintDismiss(hintId),
      });

      if (hintsToRender.length >= 3) {
        break;
      }
    }

    this.visibleHintIds = new Set(hintsToRender.map((hint) => hint.id));
    this.chatInput.setHints(hintsToRender);
  }

  private handleHintDismiss(hintId: string) {
    this.dismissedHintIds.add(hintId);
    this.visibleHintIds.delete(hintId);

    if (!this.latestHintMetrics) {
      this.chatInput.setHints([]);
      return;
    }

    this.updateContextualInputHints(
      this.latestHintMetrics.contextPercentUsed,
      this.latestHintMetrics.usagePercentUsed
    );
  }

  private getPermissionPromptSignals(now: number): number {
    const windowMs = 20 * 60 * 1000;
    const cutoff = now - windowMs;
    const permissionRegex = /\bpermission\b/i;
    const frictionRegex = /\b(denied|approve|approval|allow)\b/i;

    let signals = 0;
    for (const message of this.messages) {
      if (message.timestamp < cutoff) {
        continue;
      }

      if (permissionRegex.test(message.content) && frictionRegex.test(message.content)) {
        signals += 1;
      }

      for (const toolCall of message.toolCalls ?? []) {
        const content = `${toolCall.error ?? ""}\n${toolCall.output ?? ""}\n${toolCall.stderr ?? ""}`;
        if (permissionRegex.test(content) && frictionRegex.test(content)) {
          signals += 1;
        }
      }
    }

    const slashSignals = (this.plugin.settings.slashCommandEvents || []).reduce((count, event) => {
      if (event.timestamp < cutoff) {
        return count;
      }
      if (event.commandId === "permissions" && event.action === "executedLocal") {
        return count + 1;
      }
      return count;
    }, 0);

    return signals + slashSignals;
  }

  private mergeToolCalls(
    previous?: ToolCall[],
    incoming?: ToolCall[]
  ): ToolCall[] | undefined {
    const merged = new Map<string, ToolCall>();
    for (const toolCall of previous ?? []) {
      merged.set(toolCall.id, toolCall);
    }
    for (const toolCall of incoming ?? []) {
      const existing = merged.get(toolCall.id);
      merged.set(toolCall.id, existing ? { ...existing, ...toolCall } : toolCall);
    }
    return merged.size > 0 ? Array.from(merged.values()) : undefined;
  }

  private mergeToolCallsForKnownIds(
    previous?: ToolCall[],
    incoming?: ToolCall[]
  ): ToolCall[] | undefined {
    if (!previous || previous.length === 0) {
      return previous;
    }
    if (!incoming || incoming.length === 0) {
      return previous;
    }

    const knownIds = new Set(previous.map((toolCall) => toolCall.id));
    const relevantIncoming = incoming.filter((toolCall) => knownIds.has(toolCall.id));
    return this.mergeToolCalls(previous, relevantIncoming);
  }

  private beginStreamingSegments(baseMessageId: string) {
    this.streamingMessageId = baseMessageId;
    this.streamingTextMessageId = baseMessageId;
    this.streamingBaseContentPrefix = null;
    this.streamingSegmentIds = [baseMessageId];
  }

  private registerStreamingSegment(messageId: string) {
    if (!this.streamingSegmentIds.includes(messageId)) {
      this.streamingSegmentIds.push(messageId);
    }
  }

  private clearStreamingSegmentation() {
    this.streamingMessageId = null;
    this.streamingTextMessageId = null;
    this.streamingBaseContentPrefix = null;
    this.streamingSegmentIds = [];
  }

  private reconcileToolCallsWithResponse(responseToolCalls: ToolCall[] | undefined, fallbackMessageId: string | null) {
    if (!responseToolCalls || responseToolCalls.length === 0) {
      return;
    }

    const byId = new Map(responseToolCalls.map((toolCall) => [toolCall.id, toolCall]));
    const seen = new Set<string>();

    for (const message of this.messages) {
      if (!message.toolCalls || message.toolCalls.length === 0) {
        continue;
      }
      let changed = false;
      message.toolCalls = message.toolCalls.map((existing) => {
        const update = byId.get(existing.id);
        if (!update) {
          return existing;
        }
        seen.add(existing.id);
        changed = true;
        return { ...existing, ...update };
      });
      if (changed) {
        this.messageList.updateMessage(message.id, message);
      }
    }

    const unmatched = responseToolCalls.filter((toolCall) => !seen.has(toolCall.id));
    if (unmatched.length === 0 || !fallbackMessageId) {
      return;
    }

    const fallbackIndex = this.messages.findIndex((message) => message.id === fallbackMessageId);
    if (fallbackIndex === -1) {
      return;
    }

    const fallbackMessage = this.messages[fallbackIndex];
    const merged = this.mergeToolCalls(fallbackMessage.toolCalls, unmatched) ?? unmatched;
    this.messages[fallbackIndex] = {
      ...fallbackMessage,
      toolCalls: merged,
    };
    this.messageList.updateMessage(fallbackMessageId, this.messages[fallbackIndex]);
  }

  private extractContinuationText(content: string): string {
    const prefix = this.streamingBaseContentPrefix ?? "";
    if (prefix && content.startsWith(prefix)) {
      return content.slice(prefix.length).replace(/^\s+/, "");
    }
    return content;
  }

  private renderMessagesArea() {
    const bodyEl = this.contentEl.createDiv({ cls: "claude-code-body" });
    this.messagesContainerEl = bodyEl.createDiv({ cls: "claude-code-messages" });
    this.messageList = new MessageList(this.messagesContainerEl, this.plugin);

    if (this.messages.length === 0) {
      this.renderEmptyState();
    } else {
      this.messageList.render(this.messages);
      this.scrollToBottom();
    }
  }

  private renderEmptyState() {
    const emptyEl = this.messagesContainerEl.createDiv({ cls: "claude-code-empty-state" });

    const iconEl = emptyEl.createDiv({ cls: "claude-code-empty-state-icon" });
    setIcon(iconEl, CLAUDE_ICON_NAME);

    const titleEl = emptyEl.createDiv({ cls: "claude-code-empty-state-title" });
    titleEl.setText("Start a conversation");

    const descEl = emptyEl.createDiv({ cls: "claude-code-empty-state-description" });
    descEl.setText("Ask Claude about your vault, get help with notes, or automate tasks. Use @ to mention files.");
  }

  private renderInputArea() {
    this.inputContainerEl = this.contentEl.createDiv({ cls: "claude-code-input-container" });
    this.chatInput = new ChatInput(this.inputContainerEl, {
      onSend: (message) => this.handleSendMessage(message),
      onCancel: () => this.handleCancelStreaming(),
      getAdditionalCommandSuggestions: () => this.getSdkSlashCommandSuggestions(),
      onCommand: (command, args) => {
        void this.handleInputCommand(command, args);
      },
      onPermissionModeChange: () => this.refreshProjectControls(),
      isStreaming: () => this.isStreaming,
      plugin: this.plugin,
    });
  }

  private async handleInputCommand(command: string, args: string[] = []) {
    logger.debug("ChatView", "Handling input command", { command, args });
    switch (command) {
      case "help":
        await this.showHelpMessage();
        break;
      case "new":
      case "clear":
        await this.startNewConversation();
        break;
      case "status":
        await this.showStatusMessage();
        break;
      case "doctor":
        await this.showDoctorMessage();
        break;
      case "cost":
        await this.showCostMessage();
        break;
      case "usage":
        await this.showUsageMessage();
        break;
      case "context":
        await this.showContextMessage();
        break;
      case "file":
        await this.handleFileContextCommand(args);
        break;
      case "rename":
        await this.handleRenameConversationCommand(args);
        break;
      case "resume":
        await this.handleResumeConversationCommand(args);
        break;
      case "pin-file":
        await this.handlePinFileCommand();
        break;
      case "pin-selection":
        await this.handlePinSelectionCommand();
        break;
      case "pin-backlinks":
        await this.handlePinBacklinksCommand(args);
        break;
      case "pins":
        await this.showPinnedContextMessage();
        break;
      case "clear-pins":
        await this.clearPinnedContextCommand();
        break;
      case "logs":
        this.openLogs();
        break;
      case "model":
        await this.handleModelCommand(args);
        break;
      case "permissions":
        await this.showPermissionsMessage();
        break;
      case "mcp":
        await this.showMcpMessage();
        break;
      case "rewind":
        await this.handleRewindCommand();
        break;
      case "checkpoint":
        await this.handleCheckpointCommand();
        break;
      default:
        break;
    }
  }

  private getSdkSlashCommandSuggestions(): Suggestion[] {
    return getExternalSlashCommandSuggestions(this.agentController.getSupportedCommands());
  }

  private async showHelpMessage() {
    const localCommands = getSlashCommands();
    const sdkCommands = this.agentController.getSupportedCommands();
    const localByValue = new Set(localCommands.map((cmd) => cmd.command.toLowerCase()));
    const externalOnly = sdkCommands
      .map((cmd) => ({
        name: normalizeSlashCommandName(cmd.name),
        description: cmd.description,
        argumentHint: cmd.argumentHint,
        origin: getExternalSlashCommandOrigin(cmd.name),
      }))
      .filter((cmd) => cmd.name && !localByValue.has(cmd.name.toLowerCase()));
    const discoveredModels = this.agentController.getSupportedModels();
    const supportedModels = discoveredModels.length > 0 ? discoveredModels : ["sonnet", "opus", "haiku"];
    const topSlashCommands = this.plugin.getTopSlashCommands(24, 5);
    const activeMcpServers = this.plugin.settings.additionalMcpServers
      .filter((server) => server.enabled && this.plugin.settings.approvedMcpServers.includes(server.name))
      .map((server) => server.name);
    const pendingMcpApprovals = this.plugin.settings.additionalMcpServers.filter(
      (server) => server.enabled && !this.plugin.settings.approvedMcpServers.includes(server.name)
    ).length;

    const localById = new Map(localCommands.map((command) => [command.id, command]));
    const commandGroups: Array<{ title: string; ids: string[] }> = [
      {
        title: "Session & Diagnostics",
        ids: ["help", "status", "doctor", "cost", "usage", "context", "model", "permissions", "mcp", "logs"],
      },
      {
        title: "Conversation",
        ids: ["new", "clear", "rename", "resume", "checkpoint", "rewind"],
      },
      {
        title: "Context Pinning",
        ids: ["file", "pin-file", "pin-selection", "pin-backlinks", "pins", "clear-pins"],
      },
    ];

    const renderedLocal = new Set<string>();
    const lines: string[] = [
      "Use `/` to open command suggestions in the composer.",
      "",
      "#### Quick Start",
      `- Current model: \`${this.plugin.settings.model}\` (available: \`${supportedModels.join(", ")}\`)`,
      `- Permission mode: \`${this.plugin.settings.permissionMode}\``,
      `- Active MCP servers: \`${activeMcpServers.length > 0 ? activeMcpServers.join(", ") : "obsidian"}\``,
      pendingMcpApprovals > 0
        ? `- MCP approvals pending: \`${pendingMcpApprovals}\` (run \`/mcp\`)`
        : "- MCP approvals pending: `none`",
      topSlashCommands.length > 0
        ? `- Top commands (24h): \`${topSlashCommands.map((entry) => `${entry.command} (${entry.total})`).join(", ")}\``
        : "- Top commands (24h): `none yet`",
      "",
      "#### Keyboard Controls",
      "- `ArrowUp`/`ArrowDown`: move through autocomplete suggestions.",
      "- `Enter`: fill selected suggestion; press `Enter` again to run/send.",
      "- `Tab`: fill selected suggestion without sending.",
      "- `Shift+Tab`: cycle permission mode (Ask to Accept -> Auto Accept Edits -> Plan).",
      "- `Esc`: close autocomplete (or stop active stream).",
      "",
      "#### Local Commands",
    ];

    for (const group of commandGroups) {
      const groupCommands = group.ids
        .map((id) => localById.get(id))
        .filter((command): command is NonNullable<typeof command> => !!command);
      if (groupCommands.length === 0) continue;

      lines.push(`- ${group.title}`);
      for (const command of groupCommands) {
        renderedLocal.add(command.id);
        lines.push(`  - ${this.formatHelpCommand(command.command, command.argumentHint, command.description)}`);
      }
    }

    const remainingLocal = localCommands.filter(
      (command) => !renderedLocal.has(command.id) && command.handler === "local"
    );
    if (remainingLocal.length > 0) {
      lines.push("- Other local commands");
      for (const command of remainingLocal) {
        lines.push(`  - ${this.formatHelpCommand(command.command, command.argumentHint, command.description)}`);
      }
    }

    const passthroughCommands = localCommands.filter((command) => command.handler === "sendToClaude");
    if (passthroughCommands.length > 0) {
      lines.push("");
      lines.push("#### Claude-Passthrough Commands");
      for (const command of passthroughCommands) {
        lines.push(`- ${this.formatHelpCommand(command.command, command.argumentHint, command.description)}`);
      }
    }

    lines.push("");
    lines.push("#### Discovered Claude Commands");
    if (externalOnly.length === 0) {
      lines.push("- `none discovered yet` (send one message to load SDK command metadata).");
    } else {
      const origins: Array<"sdk" | "project" | "personal" | "mcp"> = ["sdk", "project", "personal", "mcp"];
      const labels: Record<"sdk" | "project" | "personal" | "mcp", string> = {
        sdk: "Built-in",
        project: "Project custom",
        personal: "Personal custom",
        mcp: "MCP",
      };
      for (const origin of origins) {
        const commands = externalOnly.filter((cmd) => cmd.origin === origin);
        if (commands.length === 0) continue;
        lines.push(`- ${labels[origin]}`);
        for (const command of commands) {
          const usage = command.argumentHint ? `${command.name} ${command.argumentHint}` : command.name;
          lines.push(`  - \`${usage}\` - ${command.description || "Claude command"}`);
        }
      }
    }

    lines.push("");
    lines.push("#### Examples");
    lines.push("- `@[[Daily.md]] Summarize key tasks and blockers`");
    lines.push("- `/model opus`");
    lines.push("- `/permissions`");
    lines.push("- `/resume 2`");
    lines.push("- `/search backlinks for this note`");

    await this.appendLocalAssistantMessage("Help", lines.join("\n"));
  }

  private formatHelpCommand(command: string, argumentHint: string | undefined, description: string): string {
    const usage = argumentHint ? `${command} ${argumentHint}` : command;
    return `\`${usage}\` - ${description}`;
  }

  private formatUsageTime(iso?: string) {
    if (!iso) return "unknown";
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return "unknown";
    return dt.toLocaleString();
  }

  private async showStatusMessage() {
    const conv = this.conversationManager.getCurrentConversation();
    const auth = this.plugin.getAuthStatus();
    const plan = this.plugin.getClaudeAiPlanUsageSnapshot();
    const planErr = this.plugin.getClaudeAiPlanUsageError();
    const slashSummary = this.plugin.getSlashCommandEventSummary(24);
    const topSlashCommands = this.plugin.getTopSlashCommands(24, 5);
    const activeMcpServers = this.plugin.settings.additionalMcpServers
      .filter((server) => server.enabled && this.plugin.settings.approvedMcpServers.includes(server.name))
      .map((server) => server.name);

    const lines = [
      `- Model: \`${this.plugin.settings.model}\``,
      `- Permission mode: \`${this.plugin.settings.permissionMode}\``,
      `- Max turns: \`${this.plugin.settings.maxTurns}\``,
      `- Budget: \`$${this.plugin.settings.maxBudgetPerSession.toFixed(2)}\``,
      `- Auth: \`${auth.label}\``,
      `- Conversation: \`${conv?.title || "New Conversation"}\``,
      `- Session ID: \`${this.agentController.getSessionId() || "none"}\``,
      `- Total tokens: \`${conv?.metadata?.totalTokens ?? 0}\``,
      `- Total cost: \`$${(conv?.metadata?.totalCostUsd ?? 0).toFixed(4)}\``,
      `- Usage bar source: \`${this.plugin.settings.usageTelemetrySource || "auto"}\``,
      `- Claude plan usage (cached): \`${plan ? "available" : "unavailable"}\``,
      plan
        ? `  - 5h: \`${plan.fiveHourUtilizationPercent.toFixed(0)}%\` (resets \`${this.formatUsageTime(plan.fiveHourResetsAt)}\`)`
        : "",
      plan && Number.isFinite(plan.sevenDayUtilizationPercent)
        ? `  - 7d: \`${(plan.sevenDayUtilizationPercent ?? 0).toFixed(0)}%\` (resets \`${this.formatUsageTime(plan.sevenDayResetsAt)}\`)`
        : "",
      planErr ? `  - Last plan usage error: \`${planErr}\`` : "",
      `- Slash commands (24h): \`${slashSummary.total}\` total (\`${slashSummary.selected}\` selected, \`${slashSummary.executedLocal}\` local exec, \`${slashSummary.submittedToClaude}\` sent to Claude)`,
      topSlashCommands.length > 0
        ? `- Top slash commands (24h): \`${topSlashCommands.map((entry) => `${entry.command} (${entry.total})`).join(", ")}\``
        : "- Top slash commands (24h): `none`",
      `- Active MCP servers: \`${activeMcpServers.length > 0 ? activeMcpServers.join(", ") : "obsidian"}\``,
    ].filter(Boolean);

    await this.appendLocalAssistantMessage("Session Status", lines.join("\n"));
  }

  private async showDoctorMessage() {
    await this.plugin.refreshClaudeAiPlanUsageIfStale(0, { allowWhenBudget: true });

    const auth = this.plugin.getAuthStatus();
    const conv = this.conversationManager.getCurrentConversation();
    const sessionId = this.agentController.getSessionId();
    const supportedModels = this.agentController.getSupportedModels();
    const supportedCommands = this.agentController.getSupportedCommands();
    const plan = this.plugin.getClaudeAiPlanUsageSnapshot();
    const planErr = this.plugin.getClaudeAiPlanUsageError();
    const approvedMcp = new Set(this.plugin.settings.approvedMcpServers);
    const activeMcpServers = this.plugin.settings.additionalMcpServers.filter(
      (server) => server.enabled && approvedMcp.has(server.name)
    );
    const pendingMcpApprovals = this.plugin.settings.additionalMcpServers.filter(
      (server) => server.enabled && !approvedMcp.has(server.name)
    );
    const disabledMcpServers = this.plugin.settings.additionalMcpServers.filter((server) => !server.enabled);
    const contextWindow = this.getModelContextWindow(this.plugin.settings.model);
    const contextEstimate = computeContextUsageEstimate({
      contextWindow,
      metadata: conv?.metadata,
      history: this.conversationManager.getHistory(),
      pinnedContext: this.conversationManager.getPinnedContext(),
    });
    const permissionSignals = this.getPermissionPromptSignals(Date.now());
    const currentModel = this.plugin.settings.model;
    const modelStatus = supportedModels.length === 0
      ? "unknown (SDK metadata not loaded yet)"
      : supportedModels.includes(currentModel)
        ? "supported"
        : "not in discovered model list";

    const recommendations: string[] = [];
    if (!auth.hasEnvApiKey && !auth.hasStoredApiKey && !auth.hasOAuthToken) {
      recommendations.push("- Configure API key or OAuth in settings.");
    }
    if (!sessionId) {
      recommendations.push("- Send one message to initialize a Claude session.");
    }
    if (contextEstimate.percentUsed >= 80) {
      recommendations.push("- Context is high. Run `/context` and trim with `/clear-pins`.");
    }
    if (pendingMcpApprovals.length > 0) {
      recommendations.push("- MCP approvals pending. Run `/mcp` and approve needed servers.");
    }
    if (permissionSignals >= 2 && this.plugin.settings.permissionMode === "default") {
      recommendations.push("- Permission prompts are repeating. Review `/permissions`.");
    }
    if (planErr) {
      recommendations.push("- Plan usage fetch has errors. Run `/usage` for details.");
    }

    const lines = [
      "- Summary",
      `- Auth: \`${auth.label}\``,
      `- Session: \`${sessionId ? "connected" : "not connected"}\``,
      `- Model: \`${currentModel}\` (${modelStatus})`,
      `- Permission mode: \`${this.plugin.settings.permissionMode}\``,
      `- Context usage: \`${contextEstimate.percentUsed.toFixed(0)}%\``,
      `- SDK metadata: \`${supportedModels.length}\` models, \`${supportedCommands.length}\` commands`,
      `- MCP: \`${activeMcpServers.length}\` active, \`${pendingMcpApprovals.length}\` pending approval, \`${disabledMcpServers.length}\` disabled`,
      `- Plan usage data: \`${plan ? "available" : "unavailable"}\`${planErr ? ` (error: ${planErr})` : ""}`,
      "",
      "- Recommended actions",
      ...(recommendations.length > 0 ? recommendations : ["- No blocking issues detected."]),
      "- Run `/status` for full session details.",
    ];

    await this.appendLocalAssistantMessage("Doctor", lines.join("\n"));
  }

  private async showUsageMessage() {
    await this.plugin.refreshClaudeAiPlanUsageIfStale(0, { allowWhenBudget: true });
    const plan = this.plugin.getClaudeAiPlanUsageSnapshot();
    const planErr = this.plugin.getClaudeAiPlanUsageError();
    const fiveHourBudget = Math.max(this.plugin.settings.fiveHourUsageBudgetUsd || 0, 0.01);
    const rolling = this.plugin.getRollingUsageSummary(5);
    const localUsagePercent = Math.min(100, (rolling.costUsd / fiveHourBudget) * 100);

    if (!plan) {
      const lines = [
        "- Claude plan usage: `unavailable`",
        planErr ? `- Last error: \`${planErr}\`` : "- Last error: `none`",
        `- Local 5h usage (fallback): \`${localUsagePercent.toFixed(0)}%\` (\`$${rolling.costUsd.toFixed(2)} / $${fiveHourBudget.toFixed(2)}\`)`,
      ];
      await this.appendLocalAssistantMessage("Usage", lines.join("\n"));
      return;
    }

    const lines = [
      `- Current session (5h): \`${plan.fiveHourUtilizationPercent.toFixed(0)}%\` used`,
      `  - Resets at: \`${this.formatUsageTime(plan.fiveHourResetsAt)}\``,
      Number.isFinite(plan.sevenDayUtilizationPercent)
        ? `- Weekly limits (7d): \`${(plan.sevenDayUtilizationPercent ?? 0).toFixed(0)}%\` used`
        : "- Weekly limits (7d): `unknown`",
      plan.sevenDayResetsAt ? `  - Resets at: \`${this.formatUsageTime(plan.sevenDayResetsAt)}\`` : "",
      `- Last updated: \`${new Date(plan.fetchedAt).toLocaleString()}\``,
    ].filter(Boolean);

    await this.appendLocalAssistantMessage("Usage", lines.join("\n"));
  }

  private renderAsciiUsageBar(percent: number, width = 24): string {
    const clamped = Math.max(0, Math.min(100, percent));
    const filled = Math.round((clamped / 100) * width);
    return `[${"#".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}]`;
  }

  private async showContextMessage() {
    const conv = this.conversationManager.getCurrentConversation();
    const contextWindow = this.getModelContextWindow(this.plugin.settings.model);
    const estimate = computeContextUsageEstimate({
      contextWindow,
      metadata: conv?.metadata,
      history: this.conversationManager.getHistory(),
      pinnedContext: this.conversationManager.getPinnedContext(),
    });
    const sourceDescription =
      estimate.source === "latestTurn"
        ? "latest SDK turn usage (input + cache tokens)"
        : "fallback estimate (history + pinned context + baseline system/tools)";

    const lines = [
      `- Model: \`${this.plugin.settings.model}\``,
      `- Conversation: \`${conv?.title || "New Conversation"}\``,
      `- Context usage: \`${estimate.usedTokens.toLocaleString()} / ${estimate.contextWindow.toLocaleString()} tokens (${estimate.percentUsed.toFixed(1)}%)\``,
      `- ${this.renderAsciiUsageBar(estimate.percentUsed)}`,
      `- Source: \`${sourceDescription}\``,
      "",
      "- Breakdown",
      `- Latest input tokens: \`${estimate.breakdown.latestInputTokens.toLocaleString()}\``,
      `- Latest cache read tokens: \`${estimate.breakdown.latestCacheReadInputTokens.toLocaleString()}\``,
      `- Latest cache write tokens: \`${estimate.breakdown.latestCacheCreationInputTokens.toLocaleString()}\``,
      `- History estimate: \`${estimate.breakdown.estimatedHistoryTokens.toLocaleString()}\``,
      `- Pinned context estimate: \`${estimate.breakdown.estimatedPinnedTokens.toLocaleString()}\``,
      `- System/tools baseline estimate: \`${estimate.breakdown.estimatedSystemAndToolsTokens.toLocaleString()}\``,
      `- Free space: \`${estimate.breakdown.freeTokens.toLocaleString()}\``,
    ];

    await this.appendLocalAssistantMessage("Context", lines.join("\n"));
  }

  private async showCostMessage() {
    const conv = this.conversationManager.getCurrentConversation();
    const totalTokens = conv?.metadata?.totalTokens ?? 0;
    const totalCost = conv?.metadata?.totalCostUsd ?? 0;
    const lines = [
      `- Conversation: \`${conv?.title || "New Conversation"}\``,
      `- Total tokens: \`${totalTokens}\``,
      `- Total cost: \`$${totalCost.toFixed(4)}\``,
    ];
    await this.appendLocalAssistantMessage("Usage", lines.join("\n"));
  }

  private async handleFileContextCommand(args: string[]) {
    if (args.length === 0) {
      const added = this.addCurrentFileContext();
      if (!added) {
        new Notice("No active file to add.");
        return;
      }
      await this.appendLocalAssistantMessage("Context", "Added active file as `@` context.");
      return;
    }

    const added: string[] = [];
    const missing: string[] = [];
    for (const rawPath of args) {
      const file = this.app.vault.getFileByPath(rawPath);
      if (!file) {
        missing.push(rawPath);
        continue;
      }
      this.chatInput.addFileContext(file.path);
      added.push(file.path);
    }

    const lines = [
      added.length > 0 ? `- Added: \`${added.join(", ")}\`` : "",
      missing.length > 0 ? `- Not found: \`${missing.join(", ")}\`` : "",
    ].filter(Boolean);
    await this.appendLocalAssistantMessage("Context", lines.join("\n") || "No files added.");
  }

  private async handleRenameConversationCommand(args: string[]) {
    const conv = this.conversationManager.getCurrentConversation();
    if (!conv) return;

    const requested = args.join(" ").trim();
    if (!requested) {
      await this.beginConversationTitleEdit();
      return;
    }

    const renamed = await this.conversationManager.renameConversation(conv.id, requested);
    if (!renamed) {
      new Notice("Conversation title cannot be empty.");
      return;
    }
    (this.leaf as any).updateHeader?.();
    this.updateConversationDisplay();
    await this.appendLocalAssistantMessage("Conversation", `Renamed conversation to \`${requested}\`.`);
  }

  private async handleResumeConversationCommand(args: string[]) {
    const conversations = await this.conversationManager.getConversations();
    if (conversations.length === 0) {
      await this.appendLocalAssistantMessage(
        "Resume Conversation",
        "No saved conversations found yet."
      );
      return;
    }

    const currentId = this.conversationManager.getCurrentConversation()?.id;
    const recent = conversations.slice(0, 12);
    const query = args.join(" ").trim();

    if (!query) {
      this.openResumeConversationModal(conversations, "");
      return;
    }

    let target: Conversation | undefined;
    if (/^\d+$/.test(query)) {
      const index = Number.parseInt(query, 10);
      if (index >= 1 && index <= recent.length) {
        target = recent[index - 1];
      }
    }

    if (!target) {
      target = conversations.find((conversation) => conversation.id === query);
    }

    if (!target) {
      const normalizedQuery = query.toLowerCase();
      target = conversations.find((conversation) => (conversation.title || "").toLowerCase() === normalizedQuery);
    }

    if (!target) {
      const normalizedQuery = query.toLowerCase();
      const titleMatches = conversations.filter((conversation) =>
        (conversation.title || "").toLowerCase().includes(normalizedQuery)
      );

      if (titleMatches.length === 1) {
        target = titleMatches[0];
      } else if (titleMatches.length > 1) {
        new Notice(`Multiple matches for "${query}". Select a conversation in the picker.`);
        this.openResumeConversationModal(conversations, query);
        return;
      }
    }

    if (!target) {
      new Notice(`No exact match for "${query}". Select from filtered conversations.`);
      this.openResumeConversationModal(conversations, query);
      return;
    }

    if (target.id === currentId) {
      new Notice(`Already in "${target.title || "Untitled"}".`);
      return;
    }

    await this.loadConversation(target.id);
    new Notice(`Resumed "${target.title || "Untitled"}".`);
  }

  private openResumeConversationModal(conversations: Conversation[], initialQuery = "") {
    const currentId = this.conversationManager.getCurrentConversation()?.id ?? null;
    const modal = new ResumeConversationModal(
      this.app,
      conversations,
      currentId,
      async (conversation) => {
        if (conversation.id === currentId) {
          new Notice(`Already in "${conversation.title || "Untitled"}".`);
          return;
        }
        await this.loadConversation(conversation.id);
        new Notice(`Resumed "${conversation.title || "Untitled"}".`);
      },
      initialQuery
    );
    modal.open();
  }

  private async handlePinFileCommand() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active file to pin.");
      return;
    }
    const content = await this.app.vault.read(file);
    await this.conversationManager.addPinnedContext({
      type: "file",
      path: file.path,
      content,
      label: `File: ${file.path}`,
    });
    await this.appendLocalAssistantMessage("Pinned Context", `Pinned active file: \`${file.path}\`.`);
  }

  private async handlePinSelectionCommand() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const selection = view?.editor?.getSelection();
    if (!selection) {
      new Notice("No selection to pin.");
      return;
    }
    await this.conversationManager.addPinnedContext({
      type: "selection",
      content: selection,
      label: "Selection",
    });
    await this.appendLocalAssistantMessage("Pinned Context", "Pinned current editor selection.");
  }

  private async handlePinBacklinksCommand(args: string[]) {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active file to gather backlinks from.");
      return;
    }

    const requested = parseInt(args[0] || "3", 10);
    const limit = Number.isNaN(requested) ? 3 : Math.max(1, Math.min(10, requested));
    const backlinks = (this.app.metadataCache as any).getBacklinksForFile?.(file);
    const linkedFiles: string[] = backlinks
      ? Array.from(backlinks.data?.keys?.() ?? [])
        .map((entry: any) => (typeof entry === "string" ? entry : entry?.path || ""))
        .filter(Boolean)
      : [];
    if (linkedFiles.length === 0) {
      new Notice("No backlinks found.");
      return;
    }

    const pinned: string[] = [];
    for (const path of linkedFiles.slice(0, limit)) {
      const targetFile = this.app.vault.getFileByPath(path);
      if (!targetFile) continue;
      const content = await this.app.vault.read(targetFile);
      await this.conversationManager.addPinnedContext({
        type: "file",
        path: targetFile.path,
        content,
        label: `Backlink: ${targetFile.path}`,
      });
      pinned.push(targetFile.path);
    }

    if (pinned.length === 0) {
      new Notice("No backlink files could be pinned.");
      return;
    }
    await this.appendLocalAssistantMessage(
      "Pinned Context",
      `Pinned ${pinned.length} backlink file(s): \`${pinned.join(", ")}\`.`
    );
  }

  private async showPinnedContextMessage() {
    const pinned = this.conversationManager.getPinnedContext();
    if (pinned.length === 0) {
      await this.appendLocalAssistantMessage("Pinned Context", "No pinned context.");
      return;
    }

    const preview = pinned.slice(0, 10).map((ctx) => `- ${ctx.label}`);
    if (pinned.length > 10) {
      preview.push(`- ...and ${pinned.length - 10} more`);
    }
    await this.appendLocalAssistantMessage("Pinned Context", preview.join("\n"));
  }

  private async clearPinnedContextCommand() {
    const pinned = this.conversationManager.getPinnedContext();
    if (pinned.length === 0) {
      await this.appendLocalAssistantMessage("Pinned Context", "No pinned context to clear.");
      return;
    }
    await this.conversationManager.clearPinnedContext();
    await this.appendLocalAssistantMessage("Pinned Context", `Cleared ${pinned.length} pinned context item(s).`);
  }

  private async handleModelCommand(args: string[]) {
    const discoveredModels = this.agentController.getSupportedModels();
    const supportedModels = discoveredModels.length > 0 ? discoveredModels : ["sonnet", "opus", "haiku"];
    const requestedModel = args[0]?.toLowerCase();

    if (!requestedModel) {
      const lines = [
        `- Current model: \`${this.plugin.settings.model}\``,
        `- Available models: \`${supportedModels.join(", ")}\``,
        "- Usage: `/model sonnet`",
      ];
      await this.appendLocalAssistantMessage("Model", lines.join("\n"));
      return;
    }

    if (!supportedModels.includes(requestedModel)) {
      await this.appendLocalAssistantMessage(
        "Model",
        `Unknown model \`${requestedModel}\`. Choose one of: \`${supportedModels.join(", ")}\`.`
      );
      return;
    }

    const previous = this.plugin.settings.model;
    this.plugin.settings.model = requestedModel;
    await this.plugin.saveSettings();
    this.refreshProjectControls();
    await this.appendLocalAssistantMessage(
      "Model",
      previous === requestedModel
        ? `Model is already set to \`${requestedModel}\`.`
        : `Model changed from \`${previous}\` to \`${requestedModel}\`.`
    );
  }

  private async showPermissionsMessage() {
    const mode = this.plugin.settings.permissionMode;
    const lines = [
      `- Permission mode: \`${mode}\``,
      `- Auto-approve reads: \`${this.plugin.settings.autoApproveVaultReads}\``,
      `- Auto-approve writes: \`${this.plugin.settings.autoApproveVaultWrites}\``,
      `- Require Bash approval: \`${this.plugin.settings.requireBashApproval}\``,
      `- Review edits with diff: \`${this.plugin.settings.reviewEditsWithDiff}\``,
      `- Always-allowed tools: \`${this.plugin.settings.alwaysAllowedTools.length > 0 ? this.plugin.settings.alwaysAllowedTools.join(", ") : "none"}\``,
    ];

    if (mode === "plan") {
      lines.push("- Note: plan mode denies all tool execution.");
    } else if (mode === "acceptEdits") {
      lines.push("- Note: acceptEdits mode auto-approves file edits.");
    } else if (mode === "bypassPermissions") {
      lines.push("- Note: bypassPermissions mode allows all tools.");
    }

    await this.appendLocalAssistantMessage("Permission Status", lines.join("\n"));
  }

  private async showMcpMessage() {
    const additional = this.plugin.settings.additionalMcpServers;
    const lines = ["- Built-in: `obsidian` (enabled)"];

    if (additional.length === 0) {
      lines.push("- Additional servers: `none`");
    } else {
      for (const server of additional) {
        const approved = this.plugin.settings.approvedMcpServers.includes(server.name);
        const state = !server.enabled ? "disabled" : approved ? "enabled" : "needs approval";
        lines.push(`- ${server.name}: \`${state}\``);
      }
    }

    await this.appendLocalAssistantMessage("MCP Status", lines.join("\n"));
  }

  private async appendLocalAssistantMessage(title: string, content: string) {
    const shouldPin = this.isNearBottom();
    const message: ChatMessage = {
      id: this.generateId(),
      role: "assistant",
      content: `### ${title}\n\n${content}`,
      timestamp: Date.now(),
    };

    this.messages.push(message);

    if (this.messagesContainerEl.querySelector(".claude-code-empty-state")) {
      this.messagesContainerEl.empty();
      this.messageList = new MessageList(this.messagesContainerEl, this.plugin);
      this.messageList.render(this.messages);
    } else {
      this.messageList.addMessage(message);
    }

    if (shouldPin) {
      this.scrollToBottom();
    }

    try {
      await this.conversationManager.addMessage(message, {
        role: "assistant",
        content: message.content,
      });
      (this.leaf as any).updateHeader?.();
      this.updateConversationDisplay();
      this.refreshProjectControls();
    } catch (error) {
      logger.warn("ChatView", "Failed to persist local assistant message", { error: String(error) });
    }
  }

  private getRewindCheckpoints(limit?: number): Array<{ filePath: string; backupPath: string; timestamp: number }> {
    const checkpoints: Array<{ filePath: string; backupPath: string; timestamp: number }> = [];
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i];
      const toolCalls = message.toolCalls ?? [];
      for (let j = toolCalls.length - 1; j >= 0; j--) {
        const toolCall = toolCalls[j];
        if (toolCall.filePath && toolCall.backupPath) {
          checkpoints.push({
            filePath: toolCall.filePath,
            backupPath: toolCall.backupPath,
            timestamp: toolCall.startTime || message.timestamp,
          });
          if (limit && checkpoints.length >= limit) {
            return checkpoints;
          }
        }
      }
    }
    return checkpoints;
  }

  private async restoreCheckpoint(
    checkpoint: { filePath: string; backupPath: string },
    title = "Rewind"
  ): Promise<boolean> {
    try {
      await revertFromBackup(this.plugin.app.vault, checkpoint.filePath, checkpoint.backupPath);
      await this.appendLocalAssistantMessage(
        title,
        `Restored \`${checkpoint.filePath}\` from backup \`${checkpoint.backupPath}\`.`
      );
      return true;
    } catch (error) {
      await this.appendLocalAssistantMessage(
        title,
        `Failed to restore backup for \`${checkpoint.filePath}\`: ${String(error)}`
      );
      return false;
    }
  }

  private formatCheckpointTime(timestamp: number): string {
    const dt = new Date(timestamp);
    if (Number.isNaN(dt.getTime())) {
      return "unknown time";
    }
    return dt.toLocaleString();
  }

  private showCheckpointMenu(e: MouseEvent) {
    const checkpoints = this.getRewindCheckpoints(10);
    const menu = new Menu();

    menu.addItem((item) => {
      item.setTitle("Rewind latest edit")
        .setIcon("rotate-ccw")
        .setDisabled(checkpoints.length === 0)
        .onClick(() => {
          void this.handleRewindCommand();
        });
    });

    if (checkpoints.length > 0) {
      menu.addSeparator();
      checkpoints.forEach((checkpoint) => {
        const shortPath = checkpoint.filePath.split("/").pop() || checkpoint.filePath;
        menu.addItem((item) => {
          item.setTitle(`${shortPath} (${this.formatCheckpointTime(checkpoint.timestamp)})`)
            .setIcon("file-text")
            .onClick(() => {
              void this.restoreCheckpoint(checkpoint, "Checkpoint Restore");
            });
        });
      });
    }

    menu.showAtMouseEvent(e);
  }

  private async handleCheckpointCommand() {
    const checkpoints = this.getRewindCheckpoints(10);
    if (checkpoints.length === 0) {
      await this.appendLocalAssistantMessage(
        "Checkpoints",
        "No checkpoints are available yet. Checkpoints appear after Claude makes a file edit."
      );
      return;
    }

    const lines = checkpoints.map((checkpoint, index) =>
      `${index + 1}. \`${checkpoint.filePath}\` - ${this.formatCheckpointTime(checkpoint.timestamp)}`
    );
    lines.push("");
    lines.push("Use the rewind button in the chat header to restore a specific checkpoint.");
    await this.appendLocalAssistantMessage("Checkpoints", lines.join("\n"));
  }

  private async handleRewindCommand() {
    const latest = this.getRewindCheckpoints(1)[0];
    if (!latest) {
      await this.appendLocalAssistantMessage(
        "Rewind",
        "No revertible edit was found in this conversation."
      );
      return;
    }

    await this.restoreCheckpoint(latest);
  }

  private async handleSendMessage(content: string) {
    logger.info("ChatView", "handleSendMessage called", { contentLength: content.length, preview: content.slice(0, 50) });

    if (!content.trim() || this.isStreaming) {
      logger.warn("ChatView", "Early return from handleSendMessage", { empty: !content.trim(), isStreaming: this.isStreaming });
      return;
    }

    // Store for retry functionality.
    this.lastUserMessage = content.trim();
    const shouldPin = this.isNearBottom();
    // Lock streaming immediately to prevent rapid double-submit races.
    this.isStreaming = true;
    this.chatInput.updateState();

    // Add user message to UI.
    const userMessage: ChatMessage = {
      id: this.generateId(),
      role: "user",
      content: content.trim(),
      timestamp: Date.now(),
    };
    this.messages.push(userMessage);
    logger.debug("ChatView", "User message created", { id: userMessage.id });

    // Save to conversation.
    try {
      logger.debug("ChatView", "Saving to conversation manager");
      await this.conversationManager.addMessage(userMessage, {
        role: "user",
        content: content.trim(),
      });
      logger.debug("ChatView", "Conversation saved");
    } catch (e) {
      logger.error("ChatView", "Failed to save to conversation", { error: String(e) });
    }

    // Clear empty state and render.
    logger.debug("ChatView", "Rendering messages");
    if (this.messagesContainerEl.querySelector(".claude-code-empty-state")) {
      this.messagesContainerEl.empty();
      this.messageList = new MessageList(this.messagesContainerEl, this.plugin);
      this.messageList.render(this.messages);
    } else {
      this.messageList.addMessage(userMessage);
    }
    if (shouldPin) {
      this.scrollToBottom();
    }

    // Immediately show a "thinking" placeholder message for instant feedback.
    const placeholderId = this.generateId();
    const placeholderMessage: ChatMessage = {
      id: placeholderId,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      isStreaming: true,
    };
    this.messages.push(placeholderMessage);
    this.beginStreamingSegments(placeholderId);
    this.messageList.addMessage(placeholderMessage);
    if (shouldPin) {
      this.scrollToBottom();
    }

    // Capture current conversation ID for this stream (for background streaming support).
    const currentConv = this.conversationManager.getCurrentConversation();
    this.activeStreamConversationId = currentConv?.id || null;
    this.agentController.setActiveConversationId(this.activeStreamConversationId);
    const streamConvId = this.activeStreamConversationId;
    const streamMsgId = this.streamingMessageId;

    logger.info("ChatView", "Calling agentController.sendMessage", { streamConvId });
    try {
      // Send to agent and get response.
      const response = await this.agentController.sendMessage(this.buildPromptWithPinnedContext(content.trim()));

      // Save to the conversation that started the stream (may be different from current if user switched).
      if (streamConvId) {
        await this.conversationManager.addMessageToConversation(streamConvId, response);
        const usageSample = this.agentController.getLastUsageSample();
        if (usageSample) {
          await this.conversationManager.updateUsageForConversation(
            streamConvId,
            usageSample.totalTokens,
            usageSample.costUsd,
            usageSample.inputTokens,
            usageSample.outputTokens,
            {
              latestContextTokens: usageSample.contextTokens,
              latestInputTokens: usageSample.inputTokens,
              latestOutputTokens: usageSample.outputTokens,
              latestCacheReadInputTokens: usageSample.cacheReadInputTokens,
              latestCacheCreationInputTokens: usageSample.cacheCreationInputTokens,
            }
          );
        }
        const sessionId = this.agentController.getSessionId();
        if (sessionId) {
          await this.conversationManager.updateSessionIdForConversation(streamConvId, sessionId);
        }
      }

      if (!this.finalizeStreamingResponse(streamConvId, streamMsgId, response)) {
        const nowCurrentConv = this.conversationManager.getCurrentConversation();
        logger.info("ChatView", "Stream completed but user switched conversations", {
          streamConvId,
          currentConvId: nowCurrentConv?.id,
        });
      }
    } catch (error) {
      const errorMessage = String(error);
      const isAbort = (error as Error).name === "AbortError" || errorMessage.includes("aborted") || this.isCancelling;
      logger.error("ChatView", "Error sending message", { error: errorMessage, name: (error as Error).name, isAbort, isCancelling: this.isCancelling });

      // Remove the streaming placeholder message on error.
      if (streamMsgId) {
        const streamingIndex = this.messages.findIndex((m) => m.id === streamMsgId);
        if (streamingIndex !== -1) {
          this.messages.splice(streamingIndex, 1);
        }
      }
      // Re-render without the placeholder.
      this.messageList.render(this.messages);

      if (!isAbort) {
        console.error("Error sending message:", error);
        this.showError(error instanceof Error ? error : new Error(errorMessage));
      }
    } finally {
      logger.info("ChatView", "handleSendMessage completed");
      this.isStreaming = false;
      this.clearStreamingSegmentation();
      this.activeStreamConversationId = null;
      this.chatInput.updateState();
      this.refreshProjectControls();
    }
  }

  private buildPromptWithPinnedContext(content: string): string {
    const contexts = this.conversationManager.getPinnedContext();
    if (contexts.length === 0) return content;

    const maxChars = this.plugin.settings.maxPinnedContextChars;
    const blocks: string[] = [];
    let total = 0;

    for (const context of contexts) {
      const block = `### ${context.label}\n${context.content}`;
      if (total + block.length > maxChars) {
        const remaining = Math.max(0, maxChars - total);
        blocks.push(block.slice(0, remaining));
        break;
      }
      blocks.push(block);
      total += block.length;
    }

    return `Pinned context:\n${blocks.join("\n\n")}\n\n---\n\n${content}`;
  }

  private handleStreamingMessage(message: ChatMessage) {
    // Only update UI if we're still viewing the same conversation that owns the stream.
    const currentConv = this.conversationManager.getCurrentConversation();
    if (currentConv?.id !== this.activeStreamConversationId) {
      return; // Stream is for a different conversation, don't update UI.
    }
    const shouldPin = this.isNearBottom();

    // Update or add streaming message.
    if (this.streamingMessageId) {
      const baseIndex = this.messages.findIndex((m) => m.id === this.streamingMessageId);
      if (baseIndex !== -1) {
        const basePrevious = this.messages[baseIndex];
        const mergedContent = mergeStreamingText(basePrevious.content, message.content);
        const splitActive =
          this.streamingTextMessageId !== null &&
          this.streamingTextMessageId !== this.streamingMessageId &&
          this.streamingBaseContentPrefix !== null;

        if (!splitActive) {
          const mergedToolCalls = this.mergeToolCalls(basePrevious.toolCalls, message.toolCalls);
          const shouldSplit =
            !!mergedToolCalls &&
            mergedToolCalls.length > 0 &&
            mergedContent.length > basePrevious.content.length &&
            (basePrevious.content.length === 0 || mergedContent.startsWith(basePrevious.content));

          if (shouldSplit) {
            const continuationText = mergedContent.slice(basePrevious.content.length).replace(/^\s+/, "");
            this.messages[baseIndex] = {
              ...basePrevious,
              ...message,
              id: this.streamingMessageId,
              content: basePrevious.content,
              toolCalls: mergedToolCalls,
              isStreaming: true,
            };
            this.messageList.updateMessage(this.streamingMessageId, this.messages[baseIndex]);

            if (continuationText.trim().length > 0) {
              const continuationId = this.generateId();
              this.streamingTextMessageId = continuationId;
              this.streamingBaseContentPrefix = basePrevious.content;
              this.registerStreamingSegment(continuationId);
              const continuationMessage: ChatMessage = {
                id: continuationId,
                role: "assistant",
                content: continuationText,
                timestamp: Date.now(),
                isStreaming: true,
              };
              this.messages.push(continuationMessage);
              this.messageList.addMessage(continuationMessage);
            }
          } else {
            this.messages[baseIndex] = {
              ...basePrevious,
              ...message,
              id: this.streamingMessageId,
              content: mergedContent,
              toolCalls: mergedToolCalls,
              isStreaming: true,
            };
            this.messageList.updateMessage(this.streamingMessageId, this.messages[baseIndex]);
          }
        } else {
          const baseToolCalls = this.mergeToolCallsForKnownIds(basePrevious.toolCalls, message.toolCalls);
          this.messages[baseIndex] = {
            ...basePrevious,
            ...message,
            id: this.streamingMessageId,
            content: basePrevious.content,
            toolCalls: baseToolCalls,
            isStreaming: true,
          };
          this.messageList.updateMessage(this.streamingMessageId, this.messages[baseIndex]);

          if (this.streamingTextMessageId) {
            const textIndex = this.messages.findIndex((m) => m.id === this.streamingTextMessageId);
            const continuationText = this.extractContinuationText(message.content);
            if (textIndex !== -1) {
              const textPrevious = this.messages[textIndex];
              const mergedContinuationText = mergeStreamingText(textPrevious.content, continuationText);
              const mergedTextToolCalls = this.mergeToolCallsForKnownIds(textPrevious.toolCalls, message.toolCalls);
              const shouldSplitAgain =
                !!mergedTextToolCalls &&
                mergedTextToolCalls.length > 0 &&
                mergedContinuationText.length > textPrevious.content.length &&
                (textPrevious.content.length === 0 || mergedContinuationText.startsWith(textPrevious.content));

              if (shouldSplitAgain) {
                const continuationSuffix = mergedContinuationText
                  .slice(textPrevious.content.length)
                  .replace(/^\s+/, "");
                this.messages[textIndex] = {
                  ...textPrevious,
                  toolCalls: mergedTextToolCalls,
                  timestamp: Date.now(),
                  isStreaming: true,
                };
                this.messageList.updateMessage(this.streamingTextMessageId, this.messages[textIndex]);

                if (continuationSuffix.trim().length > 0) {
                  const continuationId = this.generateId();
                  const computedPrefix =
                    message.content.endsWith(continuationSuffix)
                      ? message.content.slice(0, message.content.length - continuationSuffix.length)
                      : `${this.streamingBaseContentPrefix ?? ""}${textPrevious.content}`;
                  this.streamingBaseContentPrefix = computedPrefix;
                  this.streamingTextMessageId = continuationId;
                  this.registerStreamingSegment(continuationId);
                  const continuationMessage: ChatMessage = {
                    id: continuationId,
                    role: "assistant",
                    content: continuationSuffix,
                    timestamp: Date.now(),
                    isStreaming: true,
                  };
                  this.messages.push(continuationMessage);
                  this.messageList.addMessage(continuationMessage);
                }
              } else if (mergedContinuationText.trim().length > 0 || textPrevious.content.length > 0) {
                this.messages[textIndex] = {
                  ...textPrevious,
                  content: mergedContinuationText,
                  toolCalls: mergedTextToolCalls,
                  timestamp: Date.now(),
                  isStreaming: true,
                };
                this.messageList.updateMessage(this.streamingTextMessageId, this.messages[textIndex]);
              }
            } else if (textIndex === -1 && continuationText.trim().length > 0) {
              const continuationMessage: ChatMessage = {
                id: this.streamingTextMessageId,
                role: "assistant",
                content: continuationText,
                timestamp: Date.now(),
                isStreaming: true,
              };
              this.messages.push(continuationMessage);
              this.messageList.addMessage(continuationMessage);
              this.registerStreamingSegment(this.streamingTextMessageId);
            }
          }
        }
      }
    } else {
      this.beginStreamingSegments(message.id);
      this.messages.push(message);
      this.messageList.addMessage(message);
    }
    if (shouldPin) {
      this.scrollToBottom();
    }
  }

  private handleToolCall(toolCall: ToolCall) {
    // Only update UI if we're still viewing the same conversation that owns the stream.
    const currentConv = this.conversationManager.getCurrentConversation();
    if (currentConv?.id !== this.activeStreamConversationId) {
      return;
    }

    const shouldPin = this.isNearBottom();

    const splitActive =
      this.streamingTextMessageId !== null &&
      this.streamingTextMessageId !== this.streamingMessageId &&
      this.streamingBaseContentPrefix !== null;
    const preferredMessageId = splitActive ? this.streamingTextMessageId : this.streamingMessageId;

    if (!preferredMessageId) {
      return;
    }

    let index = this.messages.findIndex((message) => message.id === preferredMessageId);
    let targetMessageId = preferredMessageId;
    if (index === -1 && this.streamingMessageId && preferredMessageId !== this.streamingMessageId) {
      index = this.messages.findIndex((message) => message.id === this.streamingMessageId);
      targetMessageId = this.streamingMessageId;
    }
    if (index === -1) {
      return;
    }

    if (!this.messages[index].toolCalls) {
      this.messages[index].toolCalls = [];
    }
    // Deduplicate: only add if not already present (prevents double-add from shared references).
    const existing = this.messages[index].toolCalls!.find((tool) => tool.id === toolCall.id);
    if (!existing) {
      this.messages[index].toolCalls!.push(toolCall);
      this.registerStreamingSegment(targetMessageId);
      this.messageList.updateMessage(targetMessageId, this.messages[index]);
      if (shouldPin) {
        this.scrollToBottom();
      }
    }
  }

  private handleToolResult(toolCallId: string, result: string, isError: boolean) {
    // Only update UI if we're still viewing the same conversation that owns the stream.
    const currentConv = this.conversationManager.getCurrentConversation();
    if (currentConv?.id !== this.activeStreamConversationId) {
      return;
    }

    const shouldPin = this.isNearBottom();

    const message = this.findMessageWithToolCall(toolCallId);
    if (!message?.toolCalls) {
      return;
    }

    const toolCall = message.toolCalls.find((tool) => tool.id === toolCallId);
    if (!toolCall) {
      return;
    }

    toolCall.output = result;
    toolCall.status = isError ? "error" : "success";
    toolCall.endTime = Date.now();
    if (isError) {
      toolCall.error = result;
    }

    this.messageList.updateMessage(message.id, message);
    if (shouldPin) {
      this.scrollToBottom();
    }
  }

  private handleSubagentStart(toolCallId: string, subagentType: string, subagentId: string) {
    logger.debug("ChatView", "Subagent started", { toolCallId, subagentType, subagentId });

    // Find the message containing this tool call.
    const message = this.findMessageWithToolCall(toolCallId);
    if (message) {
      const toolCall = message.toolCalls?.find((tc) => tc.id === toolCallId);
      if (toolCall) {
        toolCall.subagentStatus = "running";
        toolCall.subagentId = subagentId;
        if (toolCall.subagentProgress) {
          toolCall.subagentProgress.message = `${subagentType} agent running...`;
          toolCall.subagentProgress.lastUpdate = Date.now();
        }
        const shouldPin = this.isNearBottom();
        this.messageList.updateMessage(message.id, message);
        if (shouldPin) {
          this.scrollToBottom();
        }
      }
    }
  }

  private handleSubagentStop(toolCallId: string, success: boolean, error?: string) {
    logger.debug("ChatView", "Subagent stopped", { toolCallId, success, error });

    // Find the message containing this tool call.
    const message = this.findMessageWithToolCall(toolCallId);
    if (message) {
      const toolCall = message.toolCalls?.find((tc) => tc.id === toolCallId);
      if (toolCall) {
        toolCall.subagentStatus = success ? "completed" : "error";
        if (error) {
          toolCall.error = error;
        }
        if (toolCall.subagentProgress) {
          toolCall.subagentProgress.message = success ? "Completed" : `Error: ${error || "Unknown error"}`;
          toolCall.subagentProgress.lastUpdate = Date.now();
        }
        this.messageList.updateMessage(message.id, message);
      }
    }
  }

  private findMessageWithToolCall(toolCallId: string): ChatMessage | undefined {
    for (const message of this.messages) {
      if (message.toolCalls?.some((tc) => tc.id === toolCallId)) {
        return message;
      }
    }
    return undefined;
  }

  private handleStreamingStart() {
    this.isStreaming = true;
    this.chatInput.updateState();
  }

  private handleStreamingEnd() {
    this.isStreaming = false;
    this.chatInput.updateState();
  }

  private handleError(error: Error) {
    // Don't show errors during intentional cancellation.
    if (this.isCancelling) {
      return;
    }
    // Also suppress abort errors that slip through.
    if (error.name === "AbortError" || error.message.includes("aborted")) {
      return;
    }
    this.showError(error);
  }

  private handleCancelStreaming() {
    this.agentController.cancelStream();
    this.isStreaming = false;
    this.clearStreamingSegmentation();
    this.chatInput.updateState();
  }

  private resetSession() {
    this.agentController.clearHistory();
    this.startNewConversation();
  }

  private openLogs() {
    const logPath = logger.getLogPath();
    (this.app as any).openWithDefaultApp?.(logPath);
  }

  private showError(error: Error) {
    // Get error type from attached property or classify.
    const errorType: ErrorType = (error as any).errorType || classifyError(error);

    let displayMessage: string;
    let suggestion: string | null = null;

    switch (errorType) {
      case "auth":
        displayMessage = "Authentication failed";
        suggestion = "Check your API key in settings or verify your Claude Max subscription is active";
        break;
      case "network":
        displayMessage = "Network error";
        suggestion = "Check your internet connection and try again";
        break;
      case "transient":
        displayMessage = "Claude encountered an unexpected error";
        suggestion = "This usually resolves itself. Try again.";
        break;
      default:
        displayMessage = error.message || "Unknown error";
    }

    const errorEl = this.messagesContainerEl.createDiv({ cls: "claude-code-error" });

    const titleEl = errorEl.createDiv({ cls: "claude-code-error-title" });
    titleEl.setText(displayMessage);

    if (suggestion) {
      const suggestionEl = errorEl.createDiv({ cls: "claude-code-error-suggestion" });
      suggestionEl.setText(suggestion);
    }

    // Add retry button for transient and network errors.
    if (errorType === "transient" || errorType === "network") {
      const actionsEl = errorEl.createDiv({ cls: "claude-code-error-actions" });
      const retryBtn = actionsEl.createEl("button", {
        text: "Retry",
        cls: "claude-code-error-retry mod-cta",
      });
      retryBtn.addEventListener("click", () => {
        errorEl.remove();
        this.retryLastMessage();
      });
    }

    // Add settings link for auth errors.
    if (errorType === "auth") {
      const actionsEl = errorEl.createDiv({ cls: "claude-code-error-actions" });
      const settingsBtn = actionsEl.createEl("button", {
        text: "Open Settings",
        cls: "claude-code-error-retry",
      });
      settingsBtn.addEventListener("click", () => {
        (this.app as any).setting.open();
        (this.app as any).setting.openTabById("obsidian-claude-code");
      });
    }

    this.scrollToBottom();
  }

  private async retryLastMessage() {
    if (this.lastUserMessage) {
      // Remove the last user message from the conversation (it was already added).
      // We want to re-send the same message without duplicating it.
      const lastIndex = this.messages.findIndex(
        (m) => m.role === "user" && m.content === this.lastUserMessage
      );
      if (lastIndex !== -1) {
        // Keep the user message, just retry sending.
        await this.sendMessageWithContent(this.lastUserMessage);
      }
    }
  }

  private async sendMessageWithContent(content: string) {
    // Start streaming.
    this.isStreaming = true;
    this.chatInput.updateState();
    const shouldPin = this.isNearBottom();

    // Show "thinking" placeholder.
    const placeholderId = this.generateId();
    const placeholderMessage: ChatMessage = {
      id: placeholderId,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      isStreaming: true,
    };
    this.messages.push(placeholderMessage);
    this.beginStreamingSegments(placeholderId);
    this.messageList.render(this.messages);
    if (shouldPin) {
      this.scrollToBottom();
    }

    // Capture current conversation ID.
    const currentConv = this.conversationManager.getCurrentConversation();
    this.activeStreamConversationId = currentConv?.id || null;
    this.agentController.setActiveConversationId(this.activeStreamConversationId);
    const streamConvId = this.activeStreamConversationId;
    const streamMsgId = this.streamingMessageId;

    try {
      const response = await this.agentController.sendMessage(this.buildPromptWithPinnedContext(content));

      // Save to the conversation that started the stream.
      if (streamConvId) {
        await this.conversationManager.addMessageToConversation(streamConvId, response);
        const usageSample = this.agentController.getLastUsageSample();
        if (usageSample) {
          await this.conversationManager.updateUsageForConversation(
            streamConvId,
            usageSample.totalTokens,
            usageSample.costUsd,
            usageSample.inputTokens,
            usageSample.outputTokens,
            {
              latestContextTokens: usageSample.contextTokens,
              latestInputTokens: usageSample.inputTokens,
              latestOutputTokens: usageSample.outputTokens,
              latestCacheReadInputTokens: usageSample.cacheReadInputTokens,
              latestCacheCreationInputTokens: usageSample.cacheCreationInputTokens,
            }
          );
        }
        const sessionId = this.agentController.getSessionId();
        if (sessionId) {
          await this.conversationManager.updateSessionIdForConversation(streamConvId, sessionId);
        }
      }

      this.finalizeStreamingResponse(streamConvId, streamMsgId, response);
    } catch (error) {
      const errorMessage = String(error);
      const isAbort = (error as Error).name === "AbortError" || errorMessage.includes("aborted") || this.isCancelling;

      // Remove the streaming placeholder message on error.
      if (streamMsgId) {
        const streamingIndex = this.messages.findIndex((m) => m.id === streamMsgId);
        if (streamingIndex !== -1) {
          this.messages.splice(streamingIndex, 1);
        }
      }
      this.messageList.render(this.messages);

      if (!isAbort) {
        this.showError(error instanceof Error ? error : new Error(errorMessage));
      }
    } finally {
      this.isStreaming = false;
      this.clearStreamingSegmentation();
      this.activeStreamConversationId = null;
      this.chatInput.updateState();
      this.refreshProjectControls();
    }
  }

  private finalizeStreamingResponse(streamConvId: string | null, streamMsgId: string | null, response: ChatMessage): boolean {
    const nowCurrentConv = this.conversationManager.getCurrentConversation();
    if (nowCurrentConv?.id !== streamConvId) {
      return false;
    }

    const shouldPinFinal = this.isNearBottom();
    const streamingIndex = this.messages.findIndex((m) => m.id === streamMsgId);
    const splitTextId = this.streamingTextMessageId;
    const hasSplit = !!splitTextId && splitTextId !== streamMsgId && this.streamingBaseContentPrefix !== null;
    const fallbackToolMessageId = hasSplit ? splitTextId : streamMsgId;

    if (streamingIndex !== -1) {
      const previous = this.messages[streamingIndex];
      this.messages[streamingIndex] = {
        ...response,
        id: previous.id,
        content: hasSplit ? previous.content : mergeStreamingText(previous.content, response.content),
        toolCalls: hasSplit
          ? this.mergeToolCallsForKnownIds(previous.toolCalls, response.toolCalls)
          : this.mergeToolCalls(previous.toolCalls, response.toolCalls),
        isStreaming: false,
      };
    } else if (!hasSplit) {
      this.messages.push(response);
    }

    if (hasSplit) {
      const continuationText = this.extractContinuationText(response.content).trim();
      if (continuationText.length > 0 && splitTextId) {
        const textIndex = this.messages.findIndex((m) => m.id === splitTextId);
        if (textIndex !== -1) {
          const previousText = this.messages[textIndex];
          this.messages[textIndex] = {
            ...previousText,
            content: mergeStreamingText(previousText.content, continuationText),
            toolCalls: this.mergeToolCallsForKnownIds(previousText.toolCalls, response.toolCalls),
            isStreaming: false,
            timestamp: Date.now(),
          };
        } else {
          this.messages.push({
            id: splitTextId,
            role: "assistant",
            content: continuationText,
            timestamp: Date.now(),
            isStreaming: false,
          });
          this.registerStreamingSegment(splitTextId);
        }
      }
    }

    for (const segmentId of this.streamingSegmentIds) {
      const segmentIndex = this.messages.findIndex((message) => message.id === segmentId);
      if (segmentIndex === -1) {
        continue;
      }
      if (this.messages[segmentIndex].isStreaming) {
        this.messages[segmentIndex] = {
          ...this.messages[segmentIndex],
          isStreaming: false,
        };
      }
    }

    this.reconcileToolCallsWithResponse(response.toolCalls, fallbackToolMessageId ?? null);

    this.messageList.render(this.messages);
    if (shouldPinFinal) {
      this.scrollToBottom();
    }

    return true;
  }

  async startNewConversation() {
    logger.info("ChatView", "startNewConversation called");

    // DON'T cancel the stream - let it complete in background.
    // The activeStreamConversationId tracks which conversation owns the stream.
    // When creating new conversation, we just clear UI state but stream continues.

    // Clear UI streaming state (but stream continues in background).
    this.clearStreamingSegmentation();
    this.isStreaming = false;

    // Clear state.
    this.messages = [];
    this.agentController.clearHistory();
    this.conversationManager.clearCurrent();

    // Create new conversation.
    await this.conversationManager.createConversation();

    // Re-render (clear errors too).
    this.messagesContainerEl.empty();
    this.renderEmptyState();
    logger.info("ChatView", "startNewConversation rendered empty state");

    this.chatInput.updateState();

    // Update tab title and header.
    (this.leaf as any).updateHeader?.();
    this.updateConversationDisplay();
    this.refreshProjectControls();
  }

  private async showHistory() {
    const modal = new ConversationHistoryModal(
      this.app,
      this.conversationManager,
      async (id) => {
        // Load selected conversation.
        const conv = await this.conversationManager.loadConversation(id);
        if (conv) {
          this.messages = this.conversationManager.getDisplayMessages();
          // Set the session ID for resumption (SDK handles history internally).
          if (conv.sessionId) {
            this.agentController.setSessionId(conv.sessionId);
          }
          this.messagesContainerEl.empty();
          this.messageList = new MessageList(this.messagesContainerEl, this.plugin);
          if (this.messages.length === 0) {
            this.renderEmptyState();
          } else {
            this.messageList.render(this.messages);
            this.scrollToBottom();
          }
          // Update tab title and header.
          (this.leaf as any).updateHeader?.();
          this.updateConversationDisplay();
        }
      },
      async (id) => {
        // Delete conversation.
        await this.conversationManager.deleteConversation(id);
      }
    );
    modal.open();
  }

  private generateId(): string {
    return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  addCurrentFileContext(): boolean {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) {
      this.chatInput.addFileContext(activeFile.path);
      return true;
    }
    return false;
  }

  scrollToBottom() {
    this.messagesContainerEl.scrollTop = this.messagesContainerEl.scrollHeight;
  }

  private isNearBottom(threshold = 160): boolean {
    const { scrollTop, scrollHeight, clientHeight } = this.messagesContainerEl;
    return scrollHeight - (scrollTop + clientHeight) <= threshold;
  }
}
