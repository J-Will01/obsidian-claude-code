import { vi } from "vitest";

import { createMockApp } from "../mocks/obsidian/App.mock";
import { createMockVault } from "../mocks/obsidian/Vault.mock";

// Create a mock plugin instance.
export function createMockPlugin(overrides?: Partial<MockPlugin>): MockPlugin {
  const app = overrides?.app ?? createMockApp();

  const defaultSettings: MockPluginSettings = {
    apiKey: "test-api-key",
    oauthToken: "",
    baseUrl: "",
    model: "sonnet",
    maxTokens: 4096,
    systemPrompt: "",
    autoApproveReadOnly: true,
    enableSkills: true,
    // AgentController settings.
    maxBudgetPerSession: 5.0,
    maxTurns: 10,
    permissionMode: "default",
    autoApproveVaultWrites: true,
    requireBashApproval: false,
    reviewEditsWithDiff: false,
    alwaysAllowedTools: [],
    storeApiKeyInKeychain: false,
    autoApproveVaultReads: true,
    sidebarWidth: 400,
    showProjectControlsPanel: true,
    maxPinnedContextChars: 8000,
    fiveHourUsageBudgetUsd: 10.0,
    additionalMcpServers: [],
    approvedMcpServers: [],
    usageEvents: [],
  };

  // Extract settings from overrides to merge separately.
  const { settings: settingsOverrides, ...otherOverrides } = overrides ?? {};

  return {
    app,
    manifest: {
      id: "obsidian-claude-code",
      name: "Claude Code",
      version: "0.1.0",
      minAppVersion: "1.0.0",
      description: "Claude Code AI assistant for Obsidian",
      author: "Test",
      authorUrl: "",
      isDesktopOnly: true,
    },
    settings: { ...defaultSettings, ...settingsOverrides },
    loadData: vi.fn().mockResolvedValue({}),
    saveData: vi.fn().mockResolvedValue(undefined),
    saveSettings: vi.fn().mockResolvedValue(undefined),
    recordUsageEvent: vi.fn().mockResolvedValue(undefined),
    getRollingUsageSummary: vi.fn().mockReturnValue({
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    }),
    getApiKey: vi.fn().mockReturnValue((settingsOverrides?.apiKey ?? defaultSettings.apiKey)),
    getOAuthToken: vi.fn().mockReturnValue((settingsOverrides?.oauthToken ?? defaultSettings.oauthToken)),
    ...otherOverrides,
  };
}

export interface MockPluginSettings {
  apiKey: string;
  oauthToken: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  systemPrompt: string;
  autoApproveReadOnly: boolean;
  enableSkills: boolean;
  // AgentController settings.
  maxBudgetPerSession: number;
  maxTurns: number;
  permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  autoApproveVaultWrites: boolean;
  requireBashApproval: boolean;
  reviewEditsWithDiff: boolean;
  alwaysAllowedTools: string[];
  storeApiKeyInKeychain: boolean;
  autoApproveVaultReads: boolean;
  sidebarWidth: number;
  showProjectControlsPanel: boolean;
  maxPinnedContextChars: number;
  fiveHourUsageBudgetUsd: number;
  additionalMcpServers: { name: string; command: string; args: string[]; env?: Record<string, string>; enabled: boolean }[];
  approvedMcpServers: string[];
  usageEvents: Array<{ timestamp: number; costUsd: number; inputTokens: number; outputTokens: number }>;
}

export interface MockPlugin {
  app: ReturnType<typeof createMockApp>;
  manifest: {
    id: string;
    name: string;
    version: string;
    minAppVersion: string;
    description: string;
    author: string;
    authorUrl: string;
    isDesktopOnly: boolean;
  };
  settings: MockPluginSettings;
  loadData: ReturnType<typeof vi.fn>;
  saveData: ReturnType<typeof vi.fn>;
  saveSettings: ReturnType<typeof vi.fn>;
  recordUsageEvent: ReturnType<typeof vi.fn>;
  getRollingUsageSummary: ReturnType<typeof vi.fn>;
  getApiKey: ReturnType<typeof vi.fn>;
  getOAuthToken: ReturnType<typeof vi.fn>;
}

// Create a mock conversation.
export function createMockConversation(overrides?: Partial<MockConversation>): MockConversation {
  const now = Date.now();
  return {
    id: `conv-${now}`,
    title: "Test Conversation",
    createdAt: now,
    updatedAt: now,
    messages: [],
    sessionId: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...overrides,
  };
}

export interface MockConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: MockMessage[];
  sessionId: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

// Create a mock message.
export function createMockMessage(overrides?: Partial<MockMessage>): MockMessage {
  return {
    role: "user",
    content: "Test message",
    timestamp: Date.now(),
    ...overrides,
  };
}

export interface MockMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  toolCalls?: MockToolCall[];
}

// Create a mock tool call.
export function createMockToolCall(overrides?: Partial<MockToolCall>): MockToolCall {
  return {
    id: `tool-${Date.now()}`,
    name: "Read",
    input: { file_path: "/test/file.md" },
    status: "completed",
    result: "File content here",
    startTime: Date.now(),
    endTime: Date.now() + 100,
    ...overrides,
  };
}

export interface MockToolCall {
  id: string;
  name: string;
  input: any;
  status: "pending" | "running" | "completed" | "error";
  result?: string;
  error?: string;
  startTime: number;
  endTime?: number;
}

// Create a mock vault with files.
export function createMockVaultWithFiles(
  files: Record<string, string>
): ReturnType<typeof createMockVault> {
  const vault = createMockVault();

  for (const [path, content] of Object.entries(files)) {
    vault._files.set(path, content);
  }

  // Update mock implementations to use the files.
  vault.getMarkdownFiles.mockReturnValue(
    Object.keys(files)
      .filter((p) => p.endsWith(".md"))
      .map((p) => ({ path: p, name: p.split("/").pop() }))
  );

  vault.getFiles.mockReturnValue(
    Object.keys(files).map((p) => ({ path: p, name: p.split("/").pop() }))
  );

  vault.getAbstractFileByPath.mockImplementation((path: string) => {
    if (files[path] !== undefined) {
      return { path, name: path.split("/").pop() };
    }
    return null;
  });

  return vault;
}

// Create random test data for property-based testing.
export function createRandomString(length: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function createRandomId(): string {
  return `${Date.now()}-${createRandomString(8)}`;
}
