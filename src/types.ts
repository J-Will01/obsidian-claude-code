import { ItemView } from "obsidian";

// View type constant for registration.
export const CHAT_VIEW_TYPE = "claude-code-chat-view";

// Plugin settings interface.
export interface ClaudeCodeSettings {
  // API Configuration.
  apiKey: string;
  oauthToken: string;
  baseUrl: string;
  model: string;
  storeApiKeyInKeychain: boolean;

  // Permissions.
  autoApproveVaultReads: boolean;
  autoApproveVaultWrites: boolean;
  requireBashApproval: boolean;
  reviewEditsWithDiff: boolean;

  // Persistent permission approvals (tools that are always allowed).
  alwaysAllowedTools: string[];

  // UI Preferences.
  sidebarWidth: number;
  showProjectControlsPanel: boolean;

  // Limits.
  maxBudgetPerSession: number;
  maxPinnedContextChars: number;
  fiveHourUsageBudgetUsd: number;

  // Agent SDK settings.
  maxTurns: number;
  permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions";

  // MCP servers.
  additionalMcpServers: McpServerSetting[];
  approvedMcpServers: string[];

  // Rolling usage telemetry.
  usageEvents: UsageEvent[];
}

// Default settings values.
export const DEFAULT_SETTINGS: ClaudeCodeSettings = {
  apiKey: "",
  oauthToken: "",
  baseUrl: "",
  model: "sonnet",
  storeApiKeyInKeychain: false,
  autoApproveVaultReads: true,
  autoApproveVaultWrites: false,
  requireBashApproval: true,
  reviewEditsWithDiff: false,
  alwaysAllowedTools: [],
  sidebarWidth: 400,
  showProjectControlsPanel: true,
  maxBudgetPerSession: 10.0,
  maxPinnedContextChars: 8000,
  fiveHourUsageBudgetUsd: 10.0,
  maxTurns: 50,
  permissionMode: "default",
  additionalMcpServers: [],
  approvedMcpServers: [],
  usageEvents: [],
};

export interface UsageEvent {
  timestamp: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

// Error classification for retry and display logic.
export type ErrorType = "transient" | "auth" | "network" | "permanent";

// Error with classification for better handling.
export interface ClassifiedError extends Error {
  errorType: ErrorType;
}

// Message roles for conversation.
export type MessageRole = "user" | "assistant";

// Stored history entry for persisted conversation context.
export interface ConversationHistoryEntry {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

// Chat message structure.
export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  isStreaming?: boolean;
}

// Subagent status for lifecycle tracking.
export type SubagentStatus = "starting" | "running" | "thinking" | "completed" | "interrupted" | "error";

// Subagent progress information.
export interface SubagentProgress {
  message?: string;
  startTime: number;
  lastUpdate: number;
}

// Tool call information for display.
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  raw?: unknown;
  status: "pending" | "running" | "success" | "error";
  error?: string;
  startTime: number;
  endTime?: number;
  filePath?: string;
  backupPath?: string;
  diff?: string;

  // Subagent-specific fields for Task tool calls.
  isSubagent?: boolean;
  subagentId?: string;
  subagentType?: string;
  subagentStatus?: SubagentStatus;
  subagentProgress?: SubagentProgress;
}

// Conversation metadata (SDK handles actual state).
export interface Conversation {
  id: string;
  sessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  metadata: {
    totalTokens: number;
    totalCostUsd: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  pinnedContext?: MessageContext[];
}

// Context that can be attached to a message.
export interface MessageContext {
  type: "file" | "selection" | "search";
  path?: string;
  content: string;
  label: string;
}

export interface McpServerSetting {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

// Events emitted by the agent controller.
export interface AgentEvents {
  onMessage: (message: ChatMessage) => void;
  onToolCall: (toolCall: ToolCall) => void;
  onToolResult: (toolCallId: string, result: string, isError: boolean) => void;
  onStreamingStart: () => void;
  onStreamingEnd: () => void;
  onError: (error: Error) => void;

  // Subagent lifecycle events.
  onSubagentStart?: (toolCallId: string, subagentType: string, subagentId: string) => void;
  onSubagentStop?: (toolCallId: string, success: boolean, error?: string) => void;
  onSubagentProgress?: (toolCallId: string, message: string) => void;
}

// Permission request for tool approval.
export interface PermissionRequest {
  toolName: string;
  toolInput: Record<string, unknown>;
  description: string;
  risk: "low" | "medium" | "high";
}

// Slash command definition.
export interface SlashCommand {
  name: string;
  description: string;
  path: string;
  template: string;
}

// File suggestion for autocomplete.
export interface FileSuggestion {
  path: string;
  name: string;
  isFolder: boolean;
}
