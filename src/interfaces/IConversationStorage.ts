import type { Conversation, ChatMessage, ConversationHistoryEntry } from "../types";

/**
 * Stored conversation data with full history.
 */
export interface StoredConversation extends Conversation {
  history: ConversationHistoryEntry[];
  displayMessages: ChatMessage[];
}

/**
 * Index of all conversations.
 */
export interface ConversationIndex {
  conversations: Conversation[];
  activeConversationId: string | null;
}

/**
 * Abstraction over conversation persistence.
 * Allows for easy mocking in tests without requiring file system access.
 */
export interface IConversationStorage {
  /**
   * Load the conversation index.
   */
  loadIndex(): Promise<ConversationIndex>;

  /**
   * Save the conversation index.
   */
  saveIndex(index: ConversationIndex): Promise<void>;

  /**
   * Load a conversation by ID.
   */
  loadConversation(id: string): Promise<StoredConversation | null>;

  /**
   * Save a conversation.
   */
  saveConversation(conversation: StoredConversation): Promise<void>;

  /**
   * Delete a conversation.
   */
  deleteConversation(id: string): Promise<void>;

  /**
   * Check if storage is initialized.
   */
  isInitialized(): boolean;

  /**
   * Initialize the storage (create directories, etc.).
   */
  initialize(): Promise<void>;
}
