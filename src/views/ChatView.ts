import { ItemView, WorkspaceLeaf, setIcon, Menu, ViewStateResult } from "obsidian";
import { CHAT_VIEW_TYPE, ChatMessage, ToolCall, Conversation, ErrorType } from "../types";
import type ClaudeCodePlugin from "../main";
import { ChatInput } from "./ChatInput";
import { MessageList } from "./MessageList";
import { AgentController, classifyError } from "../agent/AgentController";
import { ConversationManager } from "../agent/ConversationManager";
import { ConversationHistoryModal } from "./ConversationHistoryModal";
import { logger } from "../utils/Logger";
import { ProjectControls } from "./components/ProjectControls";
import { CLAUDE_ICON_NAME } from "../utils/icons";
import { revertFromBackup } from "../utils/DiffEngine";

export class ChatView extends ItemView {
  plugin: ClaudeCodePlugin;
  private headerEl!: HTMLElement;
  private messagesContainerEl!: HTMLElement;
  private inputContainerEl!: HTMLElement;
  private messageList!: MessageList;
  private chatInput!: ChatInput;
  private projectControls: ProjectControls | null = null;
  private messages: ChatMessage[] = [];
  private isStreaming = false;
  private agentController: AgentController;
  private conversationManager: ConversationManager;
  private streamingMessageId: string | null = null;
  private viewId: string;
  private isCancelling = false;  // Flag to suppress error display during intentional cancel.
  private activeStreamConversationId: string | null = null;  // Track which conversation owns the active stream.
  private lastUserMessage: string | null = null;  // Store last message for retry functionality.

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
    convPicker.addEventListener("click", (e) => this.showConversationPicker(e));

    // Actions section.
    const actionsEl = this.headerEl.createDiv({ cls: "claude-code-header-actions" });

    // New conversation button.
    const newButton = actionsEl.createEl("button", { attr: { "aria-label": "New Conversation" } });
    setIcon(newButton, "plus");
    newButton.addEventListener("click", () => this.startNewConversation());

    // New window button.
    const newWindowButton = actionsEl.createEl("button", { attr: { "aria-label": "New Chat Window" } });
    setIcon(newWindowButton, "plus-square");
    newWindowButton.addEventListener("click", (e) => this.showNewWindowMenu(e));

    // History button.
    const historyButton = actionsEl.createEl("button", { attr: { "aria-label": "History" } });
    setIcon(historyButton, "history");
    historyButton.addEventListener("click", () => this.showHistory());

    // Checkpoint/rewind button.
    const checkpointButton = actionsEl.createEl("button", {
      attr: { "aria-label": "Checkpoints and Rewind" },
    });
    setIcon(checkpointButton, "rotate-ccw");
    checkpointButton.addEventListener("click", (e) => this.showCheckpointMenu(e as MouseEvent));

    // Settings button.
    const settingsButton = actionsEl.createEl("button", { attr: { "aria-label": "Settings" } });
    setIcon(settingsButton, "settings");
    settingsButton.addEventListener("click", () => {
      (this.app as any).setting.open();
      (this.app as any).setting.openTabById("obsidian-claude-code");
    });

    // Collapse sidebar button.
    const collapseButton = actionsEl.createEl("button", { attr: { "aria-label": "Collapse Sidebar" } });
    setIcon(collapseButton, "panel-right-close");
    collapseButton.addEventListener("click", () => this.collapseSidebar());

    // Close pane button (X) - always show so user can close stuck panes.
    const closeButton = actionsEl.createEl("button", {
      attr: { "aria-label": "Close Pane" },
      cls: "claude-code-close-btn",
    });
    setIcon(closeButton, "x");
    closeButton.addEventListener("click", () => this.leaf.detach());
  }

  private collapseSidebar() {
    const rightSplit = this.app.workspace.rightSplit;
    if (rightSplit && !rightSplit.collapsed) {
      rightSplit.collapse();
    }
  }

  // Check if a leaf is contained within a workspace split.
  private isLeafInSplit(leaf: WorkspaceLeaf, split: any): boolean {
    if (!split) return false;
    let parent = leaf.parent;
    while (parent) {
      if (parent === split) return true;
      parent = (parent as any).parent;
    }
    return false;
  }

  private showNewWindowMenu(e: MouseEvent) {
    const menu = new Menu();
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

    menu.showAtMouseEvent(e);
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
    this.streamingMessageId = null;
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
  }

  private refreshProjectControls() {
    this.projectControls?.render();
  }

  private renderMessagesArea() {
    const bodyEl = this.contentEl.createDiv({ cls: "claude-code-body" });
    if (this.plugin.settings.showProjectControlsPanel) {
      const controlsEl = bodyEl.createDiv({ cls: "claude-code-project-controls-container" });
      this.projectControls = new ProjectControls({
        containerEl: controlsEl,
        app: this.app,
        plugin: this.plugin,
        conversationManager: this.conversationManager,
        onResetSession: () => this.resetSession(),
        onOpenLogs: () => this.openLogs(),
        onRewindLatest: () => {
          void this.handleRewindCommand();
        },
      });
      this.projectControls.render();
    }

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
      onCommand: (command, args) => {
        void this.handleInputCommand(command, args);
      },
      isStreaming: () => this.isStreaming,
      plugin: this.plugin,
    });
  }

  private async handleInputCommand(command: string, args: string[] = []) {
    logger.debug("ChatView", "Handling input command", { command, args });
    switch (command) {
      case "new":
      case "clear":
        await this.startNewConversation();
        break;
      case "status":
        await this.showStatusMessage();
        break;
      case "cost":
        await this.showCostMessage();
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

  private async showStatusMessage() {
    const conv = this.conversationManager.getCurrentConversation();
    const auth = this.plugin.getAuthStatus();
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
      `- Active MCP servers: \`${activeMcpServers.length > 0 ? activeMcpServers.join(", ") : "obsidian"}\``,
    ];

    await this.appendLocalAssistantMessage("Session Status", lines.join("\n"));
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

  private async handleModelCommand(args: string[]) {
    const supportedModels = ["sonnet", "opus", "haiku"];
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

    // Start streaming.
    this.isStreaming = true;
    this.chatInput.updateState();

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
    this.streamingMessageId = placeholderId;
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
        const sessionId = this.agentController.getSessionId();
        if (sessionId) {
          await this.conversationManager.updateSessionIdForConversation(streamConvId, sessionId);
        }
      }

      // Only update UI if we're still viewing the same conversation.
      const nowCurrentConv = this.conversationManager.getCurrentConversation();
      if (nowCurrentConv?.id === streamConvId) {
        const shouldPinFinal = this.isNearBottom();
        const streamingIndex = this.messages.findIndex((m) => m.id === streamMsgId);
        if (streamingIndex !== -1) {
          this.messages[streamingIndex] = response;
        } else {
          this.messages.push(response);
        }
        this.messageList.render(this.messages);
        if (shouldPinFinal) {
          this.scrollToBottom();
        }
      } else {
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
      this.streamingMessageId = null;
      this.activeStreamConversationId = null;
      this.chatInput.updateState();
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
      const index = this.messages.findIndex((m) => m.id === this.streamingMessageId);
      if (index !== -1) {
        this.messages[index] = { ...message, id: this.streamingMessageId };
        this.messageList.updateMessage(this.streamingMessageId, this.messages[index]);
      }
    } else {
      this.streamingMessageId = message.id;
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

    // Add tool call to current streaming message.
    if (this.streamingMessageId) {
      const index = this.messages.findIndex((m) => m.id === this.streamingMessageId);
      if (index !== -1) {
        if (!this.messages[index].toolCalls) {
          this.messages[index].toolCalls = [];
        }
        // Deduplicate: only add if not already present (prevents double-add from shared references).
        const existing = this.messages[index].toolCalls!.find((t) => t.id === toolCall.id);
        if (!existing) {
          this.messages[index].toolCalls!.push(toolCall);
          this.messageList.updateMessage(this.streamingMessageId, this.messages[index]);
          if (shouldPin) {
            this.scrollToBottom();
          }
        }
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

    // Update tool call status.
    if (this.streamingMessageId) {
      const index = this.messages.findIndex((m) => m.id === this.streamingMessageId);
      if (index !== -1 && this.messages[index].toolCalls) {
        const toolCall = this.messages[index].toolCalls!.find((t) => t.id === toolCallId);
        if (toolCall) {
          toolCall.output = result;
          toolCall.status = isError ? "error" : "success";
          toolCall.endTime = Date.now();
          if (isError) {
            toolCall.error = result;
          }
          this.messageList.updateMessage(this.streamingMessageId, this.messages[index]);
          if (shouldPin) {
            this.scrollToBottom();
          }
        }
      }
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
    this.streamingMessageId = null;
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
    this.streamingMessageId = placeholderId;
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
        const sessionId = this.agentController.getSessionId();
        if (sessionId) {
          await this.conversationManager.updateSessionIdForConversation(streamConvId, sessionId);
        }
      }

      // Only update UI if we're still viewing the same conversation.
      const nowCurrentConv = this.conversationManager.getCurrentConversation();
      if (nowCurrentConv?.id === streamConvId) {
        const shouldPinFinal = this.isNearBottom();
        const streamingIndex = this.messages.findIndex((m) => m.id === streamMsgId);
        if (streamingIndex !== -1) {
          this.messages[streamingIndex] = response;
        } else {
          this.messages.push(response);
        }
        this.messageList.render(this.messages);
        if (shouldPinFinal) {
          this.scrollToBottom();
        }
      }
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
      this.streamingMessageId = null;
      this.activeStreamConversationId = null;
      this.chatInput.updateState();
    }
  }

  async startNewConversation() {
    logger.info("ChatView", "startNewConversation called");

    // DON'T cancel the stream - let it complete in background.
    // The activeStreamConversationId tracks which conversation owns the stream.
    // When creating new conversation, we just clear UI state but stream continues.

    // Clear UI streaming state (but stream continues in background).
    this.streamingMessageId = null;
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

  addCurrentFileContext() {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) {
      this.chatInput.addFileContext(activeFile.path);
    }
  }

  scrollToBottom() {
    this.messagesContainerEl.scrollTop = this.messagesContainerEl.scrollHeight;
  }

  private isNearBottom(threshold = 160): boolean {
    const { scrollTop, scrollHeight, clientHeight } = this.messagesContainerEl;
    return scrollHeight - (scrollTop + clientHeight) <= threshold;
  }
}
