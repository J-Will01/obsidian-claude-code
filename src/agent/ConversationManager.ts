import type ClaudeCodePlugin from "../main";
import { Conversation, ChatMessage, MessageContext, ConversationHistoryEntry } from "../types";
import { logger } from "../utils/Logger";
import { generateTitleWithHaiku } from "../utils/formatting";
import { findClaudeExecutable } from "../utils/claudeExecutable";

// Storage directory name within the vault.
const STORAGE_DIR = ".obsidian-claude-code";
const CONVERSATIONS_FILE = "conversations.json";
const HISTORY_DIR = "history";

// Stored conversation data.
interface StoredConversation extends Conversation {
  history: ConversationHistoryEntry[];
  displayMessages: ChatMessage[];
  pinnedContext?: MessageContext[];
}

// Index of all conversations.
interface ConversationIndex {
  conversations: Conversation[];
  activeConversationId: string | null;
}

type UsageMetadataUpdate = {
  latestContextTokens?: number;
  latestInputTokens?: number;
  latestOutputTokens?: number;
  latestCacheReadInputTokens?: number;
  latestCacheCreationInputTokens?: number;
};

export class ConversationManager {
  private plugin: ClaudeCodePlugin;
  private index: ConversationIndex = {
    conversations: [],
    activeConversationId: null,
  };
  private currentConversation: StoredConversation | null = null;
  private initialized = false;

  constructor(plugin: ClaudeCodePlugin) {
    this.plugin = plugin;
  }

  // Initialize the storage directory.
  async initialize() {
    if (this.initialized) return;

    const vault = this.plugin.app.vault;

    // Create storage directory if it doesn't exist.
    try {
      const storageDir = vault.getAbstractFileByPath(STORAGE_DIR);
      if (!storageDir) {
        await vault.createFolder(STORAGE_DIR);
      }
    } catch (e) {
      // Folder may already exist, ignore error.
    }

    // Create history subdirectory.
    try {
      const historyDir = vault.getAbstractFileByPath(`${STORAGE_DIR}/${HISTORY_DIR}`);
      if (!historyDir) {
        await vault.createFolder(`${STORAGE_DIR}/${HISTORY_DIR}`);
      }
    } catch (e) {
      // Folder may already exist, ignore error.
    }

    // Load conversation index.
    await this.loadIndex();

    this.initialized = true;
  }

  // Load the conversation index.
  private async loadIndex() {
    const vault = this.plugin.app.vault;
    const indexPath = `${STORAGE_DIR}/${CONVERSATIONS_FILE}`;

    try {
      // Use adapter.read() directly to avoid Obsidian's file cache issues.
      const exists = await vault.adapter.exists(indexPath);
      if (exists) {
        const content = await vault.adapter.read(indexPath);
        this.index = JSON.parse(content);
      }
    } catch (error) {
      logger.error("ConversationManager", "Failed to load conversation index", { error: String(error) });
      this.index = { conversations: [], activeConversationId: null };
    }
  }

  // Save the conversation index.
  private async saveIndex() {
    const vault = this.plugin.app.vault;
    const indexPath = `${STORAGE_DIR}/${CONVERSATIONS_FILE}`;

    const content = JSON.stringify(this.index, null, 2);

    // Always use adapter.write() to avoid race conditions with vault.create().
    try {
      await vault.adapter.write(indexPath, content);
    } catch (e) {
      logger.error("ConversationManager", "Failed to save index", { error: String(e) });
    }
  }

  private normalizeMetadata(metadata?: Conversation["metadata"]): Conversation["metadata"] {
    return {
      totalTokens: metadata?.totalTokens ?? 0,
      totalCostUsd: metadata?.totalCostUsd ?? 0,
      inputTokens: metadata?.inputTokens ?? 0,
      outputTokens: metadata?.outputTokens ?? 0,
      latestContextTokens: metadata?.latestContextTokens ?? 0,
      latestInputTokens: metadata?.latestInputTokens ?? 0,
      latestOutputTokens: metadata?.latestOutputTokens ?? 0,
      latestCacheReadInputTokens: metadata?.latestCacheReadInputTokens ?? 0,
      latestCacheCreationInputTokens: metadata?.latestCacheCreationInputTokens ?? 0,
    };
  }

  // Create a new conversation.
  async createConversation(title?: string): Promise<Conversation> {
    await this.initialize();

    const id = this.generateId();
    const now = Date.now();

    const conversation: StoredConversation = {
      id,
      sessionId: id,
      title: title || `Conversation ${this.index.conversations.length + 1}`,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      metadata: {
        totalTokens: 0,
        totalCostUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        latestContextTokens: 0,
        latestInputTokens: 0,
        latestOutputTokens: 0,
        latestCacheReadInputTokens: 0,
        latestCacheCreationInputTokens: 0,
      },
      pinnedContext: [],
      history: [],
      displayMessages: [],
    };

    // Save the conversation.
    await this.saveConversation(conversation);

    // Add to index.
    this.index.conversations.unshift({
      id: conversation.id,
      sessionId: conversation.sessionId,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messageCount: conversation.messageCount,
      metadata: conversation.metadata,
    });
    this.index.activeConversationId = id;
    await this.saveIndex();

    this.currentConversation = conversation;
    return conversation;
  }

  // Load a conversation.
  async loadConversation(id: string): Promise<StoredConversation | null> {
    await this.initialize();

    const vault = this.plugin.app.vault;
    const path = `${STORAGE_DIR}/${HISTORY_DIR}/${id}.json`;

    try {
      // Use adapter.read() directly to avoid Obsidian's file cache issues.
      const exists = await vault.adapter.exists(path);
      if (!exists) {
        logger.error("ConversationManager", "Conversation file not found", { path });
        return null;
      }

      const content = await vault.adapter.read(path);
      const conversation = JSON.parse(content) as StoredConversation;
      conversation.pinnedContext = conversation.pinnedContext ?? [];
      conversation.metadata = this.normalizeMetadata(conversation.metadata);
      this.currentConversation = conversation;
      this.index.activeConversationId = id;
      await this.saveIndex();
      return conversation;
    } catch (error) {
      logger.error("ConversationManager", "Failed to load conversation", { error: String(error), path });
      return null;
    }
  }

  // Save the current conversation.
  private async saveConversation(conversation: StoredConversation) {
    const vault = this.plugin.app.vault;
    const path = `${STORAGE_DIR}/${HISTORY_DIR}/${conversation.id}.json`;

    const content = JSON.stringify(conversation, null, 2);

    // Always use adapter.write() to avoid race conditions with vault.create().
    try {
      await vault.adapter.write(path, content);
    } catch (e) {
      logger.error("ConversationManager", "Failed to save conversation", { error: String(e) });
    }
  }

  // Add a message to the current conversation.
  async addMessage(displayMessage: ChatMessage, historyEntry?: ConversationHistoryEntry) {
    logger.debug("ConversationManager", "addMessage called", { role: displayMessage.role, hasHistory: !!historyEntry });

    if (!this.currentConversation) {
      logger.debug("ConversationManager", "No current conversation, creating new one");
      await this.createConversation();
    }

    this.currentConversation!.displayMessages.push(displayMessage);
    if (historyEntry) {
      this.currentConversation!.history.push(historyEntry);
    }

    this.currentConversation!.messageCount++;
    this.currentConversation!.updatedAt = Date.now();

    // Auto-generate title after first assistant response using Haiku.
    // Wait until messageCount === 2 (first user + first assistant).
    if (this.currentConversation!.messageCount === 2 && displayMessage.role === "assistant") {
      await this.generateConversationTitle();
    }

    logger.debug("ConversationManager", "Saving conversation");
    await this.saveConversation(this.currentConversation!);
    await this.updateIndexEntry(this.currentConversation!);
    logger.debug("ConversationManager", "addMessage completed");
  }

  // Update usage metadata.
  async updateUsage(
    tokens: number,
    costUsd: number,
    inputTokens = 0,
    outputTokens = 0,
    metadata?: UsageMetadataUpdate
  ) {
    if (!this.currentConversation) return;

    this.currentConversation.metadata.totalTokens += tokens;
    this.currentConversation.metadata.totalCostUsd += costUsd;
    this.currentConversation.metadata.inputTokens = (this.currentConversation.metadata.inputTokens ?? 0) + inputTokens;
    this.currentConversation.metadata.outputTokens = (this.currentConversation.metadata.outputTokens ?? 0) + outputTokens;
    if (metadata) {
      this.currentConversation.metadata.latestContextTokens = Math.max(0, metadata.latestContextTokens ?? 0);
      this.currentConversation.metadata.latestInputTokens = Math.max(0, metadata.latestInputTokens ?? 0);
      this.currentConversation.metadata.latestOutputTokens = Math.max(0, metadata.latestOutputTokens ?? 0);
      this.currentConversation.metadata.latestCacheReadInputTokens = Math.max(0, metadata.latestCacheReadInputTokens ?? 0);
      this.currentConversation.metadata.latestCacheCreationInputTokens = Math.max(
        0,
        metadata.latestCacheCreationInputTokens ?? 0
      );
    }

    await this.saveConversation(this.currentConversation);
    await this.updateIndexEntry(this.currentConversation);
  }

  async updateUsageForConversation(
    conversationId: string,
    tokens: number,
    costUsd: number,
    inputTokens = 0,
    outputTokens = 0,
    metadata?: UsageMetadataUpdate
  ) {
    if (this.currentConversation?.id === conversationId) {
      await this.updateUsage(tokens, costUsd, inputTokens, outputTokens, metadata);
      return;
    }

    const path = `${STORAGE_DIR}/${HISTORY_DIR}/${conversationId}.json`;
    const vault = this.plugin.app.vault;
    const exists = await vault.adapter.exists(path);
    if (!exists) {
      return;
    }
    const content = await vault.adapter.read(path);
    const conversation = JSON.parse(content) as StoredConversation;
    conversation.metadata = this.normalizeMetadata(conversation.metadata);
    conversation.metadata.totalTokens += tokens;
    conversation.metadata.totalCostUsd += costUsd;
    conversation.metadata.inputTokens = (conversation.metadata.inputTokens ?? 0) + inputTokens;
    conversation.metadata.outputTokens = (conversation.metadata.outputTokens ?? 0) + outputTokens;
    if (metadata) {
      conversation.metadata.latestContextTokens = Math.max(0, metadata.latestContextTokens ?? 0);
      conversation.metadata.latestInputTokens = Math.max(0, metadata.latestInputTokens ?? 0);
      conversation.metadata.latestOutputTokens = Math.max(0, metadata.latestOutputTokens ?? 0);
      conversation.metadata.latestCacheReadInputTokens = Math.max(0, metadata.latestCacheReadInputTokens ?? 0);
      conversation.metadata.latestCacheCreationInputTokens = Math.max(0, metadata.latestCacheCreationInputTokens ?? 0);
    }
    await this.saveConversation(conversation);
    await this.updateIndexEntry(conversation);
  }

  // Update the index entry for a conversation.
  private async updateIndexEntry(conversation: StoredConversation) {
    const index = this.index.conversations.findIndex((c) => c.id === conversation.id);
    if (index !== -1) {
      this.index.conversations[index] = {
        id: conversation.id,
        sessionId: conversation.sessionId,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messageCount: conversation.messageCount,
        metadata: conversation.metadata,
      };
      await this.saveIndex();
    }
  }

  // Delete a conversation.
  async deleteConversation(id: string) {
    await this.initialize();

    const vault = this.plugin.app.vault;
    const path = `${STORAGE_DIR}/${HISTORY_DIR}/${id}.json`;

    const file = vault.getAbstractFileByPath(path);
    if (file) {
      await vault.delete(file as any);
    }

    this.index.conversations = this.index.conversations.filter((c) => c.id !== id);
    if (this.index.activeConversationId === id) {
      this.index.activeConversationId = this.index.conversations[0]?.id || null;
    }
    await this.saveIndex();

    if (this.currentConversation?.id === id) {
      this.currentConversation = null;
    }
  }

  // Get all conversations.
  async getConversations(): Promise<Conversation[]> {
    await this.initialize();
    return this.index.conversations;
  }

  // Get the current conversation.
  getCurrentConversation(): StoredConversation | null {
    return this.currentConversation;
  }

  async renameConversation(id: string, title: string): Promise<boolean> {
    await this.initialize();
    const nextTitle = title.trim();
    if (!nextTitle) return false;

    let conversation: StoredConversation | null = null;
    if (this.currentConversation?.id === id) {
      conversation = this.currentConversation;
    } else {
      conversation = await this.loadConversationById(id);
      if (!conversation) return false;
    }

    conversation.title = nextTitle;
    conversation.updatedAt = Date.now();
    await this.saveConversation(conversation);
    await this.updateIndexEntry(conversation);
    return true;
  }

  getPinnedContext(): MessageContext[] {
    return this.currentConversation?.pinnedContext ?? [];
  }

  async setPinnedContext(context: MessageContext[]) {
    if (!this.currentConversation) return;
    this.currentConversation.pinnedContext = context;
    await this.saveConversation(this.currentConversation);
  }

  async addPinnedContext(context: MessageContext) {
    if (!this.currentConversation) return;
    this.currentConversation.pinnedContext = this.currentConversation.pinnedContext ?? [];
    this.currentConversation.pinnedContext.push(context);
    await this.saveConversation(this.currentConversation);
  }

  async clearPinnedContext() {
    if (!this.currentConversation) return;
    this.currentConversation.pinnedContext = [];
    await this.saveConversation(this.currentConversation);
  }

  // Get the message history for the API.
  getHistory(): ConversationHistoryEntry[] {
    return this.currentConversation?.history || [];
  }

  // Get display messages for the UI.
  getDisplayMessages(): ChatMessage[] {
    return this.currentConversation?.displayMessages || [];
  }

  // Set the history (from AgentController).
  async setHistory(history: ConversationHistoryEntry[]) {
    if (this.currentConversation) {
      this.currentConversation.history = history;
      await this.saveConversation(this.currentConversation);
    }
  }

  // Update the session ID for the current conversation.
  async updateSessionId(sessionId: string) {
    if (this.currentConversation) {
      this.currentConversation.sessionId = sessionId;
      await this.saveConversation(this.currentConversation);
      await this.updateIndexEntry(this.currentConversation);
    }
  }

  // Add a message to a specific conversation by ID (for background streaming support).
  async addMessageToConversation(
    conversationId: string,
    displayMessage: ChatMessage,
    historyEntry?: ConversationHistoryEntry
  ) {
    logger.debug("ConversationManager", "addMessageToConversation called", {
      conversationId,
      role: displayMessage.role,
      isCurrentConv: this.currentConversation?.id === conversationId,
    });

    // Load the target conversation.
    let targetConv: StoredConversation | null = null;

    if (this.currentConversation?.id === conversationId) {
      targetConv = this.currentConversation;
    } else {
      // Load from disk without changing currentConversation.
      targetConv = await this.loadConversationById(conversationId);
    }

    if (!targetConv) {
      logger.error("ConversationManager", "Cannot find conversation to save to", { conversationId });
      return;
    }

    targetConv.displayMessages.push(displayMessage);
    if (historyEntry) {
      targetConv.history.push(historyEntry);
    }
    targetConv.messageCount++;
    targetConv.updatedAt = Date.now();

    // Auto-generate title after first assistant response using Haiku.
    // Wait until messageCount === 2 (first user + first assistant).
    if (targetConv.messageCount === 2 && displayMessage.role === "assistant") {
      await this.generateConversationTitleFor(targetConv);
    }

    await this.saveConversation(targetConv);
    await this.updateIndexEntry(targetConv);
    logger.debug("ConversationManager", "addMessageToConversation completed", { conversationId });
  }

  // Update the session ID for a specific conversation by ID (for background streaming support).
  async updateSessionIdForConversation(conversationId: string, sessionId: string) {
    let targetConv: StoredConversation | null = null;

    if (this.currentConversation?.id === conversationId) {
      targetConv = this.currentConversation;
    } else {
      targetConv = await this.loadConversationById(conversationId);
    }

    if (!targetConv) {
      logger.error("ConversationManager", "Cannot find conversation to update session ID", { conversationId });
      return;
    }

    targetConv.sessionId = sessionId;
    await this.saveConversation(targetConv);
    await this.updateIndexEntry(targetConv);
  }

  // Load a conversation by ID without setting it as current.
  private async loadConversationById(id: string): Promise<StoredConversation | null> {
    const vault = this.plugin.app.vault;
    const path = `${STORAGE_DIR}/${HISTORY_DIR}/${id}.json`;

    try {
      const exists = await vault.adapter.exists(path);
      if (!exists) return null;

      const content = await vault.adapter.read(path);
      const conversation = JSON.parse(content) as StoredConversation;
      conversation.pinnedContext = conversation.pinnedContext ?? [];
      conversation.metadata = this.normalizeMetadata(conversation.metadata);
      return conversation;
    } catch (error) {
      logger.error("ConversationManager", "Failed to load conversation by ID", { error: String(error), id });
      return null;
    }
  }

  // Clear current conversation.
  clearCurrent() {
    this.currentConversation = null;
  }

  // Generate a unique ID.
  private generateId(): string {
    return `conv-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  /**
   * Generate a title for the current conversation using Claude Haiku.
   *
   * This method is called automatically after the first assistant response
   * (when messageCount === 2), providing enough context for a meaningful title.
   *
   * If Haiku is unavailable or fails, falls back to simple title generation
   * (truncating the first line of the user's message to 50 characters).
   */
  private async generateConversationTitle() {
    if (!this.currentConversation) return;
    await this.generateConversationTitleFor(this.currentConversation);
  }

  /**
   * Generate a title for a specific conversation using Claude Haiku.
   * Used by both addMessage() and addMessageToConversation().
   */
  private async generateConversationTitleFor(conversation: StoredConversation) {
    const messages = conversation.displayMessages;
    if (messages.length < 2) return;

    // Get first user and assistant messages.
    const firstUser = messages.find((m) => m.role === "user");
    const firstAssistant = messages.find((m) => m.role === "assistant");

    if (!firstUser || !firstAssistant) {
      logger.debug("ConversationManager", "Missing user or assistant message for title generation");
      return;
    }

    logger.debug("ConversationManager", "Generating title with Haiku", { conversationId: conversation.id });

    try {
      // Get auth credentials, Claude executable path, and vault path from plugin.
      const apiKey = this.plugin.getApiKey() || process.env.ANTHROPIC_API_KEY;
      const oauthToken = this.plugin.getOAuthToken?.() || process.env.CLAUDE_CODE_OAUTH_TOKEN;
      const claudeExecutable = findClaudeExecutable();
      const vaultPath = (this.plugin.app.vault.adapter as any).basePath || process.cwd();

      // Try to generate title with Haiku.
      const haikuTitle = await generateTitleWithHaiku(
        firstUser.content,
        firstAssistant.content,
        apiKey,
        oauthToken,
        claudeExecutable,
        vaultPath
      );

      if (haikuTitle) {
        conversation.title = haikuTitle;
        logger.info("ConversationManager", "Generated title with Haiku", { title: haikuTitle });
      } else {
        // Fall back to simple title generation.
        conversation.title = this.generateSimpleTitle(firstUser.content);
        logger.debug("ConversationManager", "Fell back to simple title generation");
      }
    } catch (error) {
      logger.warn("ConversationManager", "Failed to generate title with Haiku", { error: String(error) });
      // Fall back to simple title generation.
      conversation.title = this.generateSimpleTitle(firstUser.content);
    }
  }

  // Generate a simple title from message content (fallback method).
  private generateSimpleTitle(content: string): string {
    const firstLine = content.split("\n")[0];
    if (firstLine.length <= 50) {
      return firstLine;
    }
    return firstLine.slice(0, 47) + "...";
  }
}
