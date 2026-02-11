import { Plugin, WorkspaceLeaf, Notice, ItemView, setIcon } from "obsidian";
import { ClaudeAiPlanUsageSnapshot, ClaudeCodeSettings, DEFAULT_SETTINGS, CHAT_VIEW_TYPE, UsageEvent } from "./types";
import { ChatView } from "./views/ChatView";
import { ClaudeCodeSettingTab } from "./settings/SettingsTab";
import { logger } from "./utils/Logger";
import {
  deleteKeychainApiKey,
  deleteKeychainOAuthToken,
  getKeychainApiKey,
  getKeychainOAuthToken,
  isKeytarAvailable,
  setKeychainApiKey,
  setKeychainOAuthToken,
} from "./utils/Keychain";
import { CLAUDE_ICON_NAME, registerClaudeIcon } from "./utils/icons";
import { fetchClaudeAiPlanUsage } from "./utils/claudeAiPlanUsage";

export default class ClaudeCodePlugin extends Plugin {
  settings: ClaudeCodeSettings = DEFAULT_SETTINGS;
  private readonly MAX_CHAT_WINDOWS = 5;
  private readonly CLAUDE_MD_FILE_NAME = "claude.md";
  private readonly CLAUDE_MD_EXPLORER_ICON_CLASS = "claude-code-claude-md-file-icon";
  private runtimeApiKey = "";
  private runtimeOAuthToken = "";
  private claudeAiPlanUsage: ClaudeAiPlanUsageSnapshot | null = null;
  private claudeAiPlanUsageLastFetchedAt = 0;
  private claudeAiPlanUsageInFlight: Promise<boolean> | null = null;
  private claudeAiPlanUsageLastError: string | null = null;
  private claudeMdFileExplorerObserver: MutationObserver | null = null;
  private claudeMdFileExplorerRefreshTimer: number | null = null;

  async onload() {
    await this.loadSettings();
    registerClaudeIcon();

    // Initialize logger with vault path.
    const vaultPath = this.getVaultPath();
    logger.setLogPath(vaultPath);
    logger.info("Plugin", "Claude Code plugin loading", { vaultPath });

    // Register the chat view.
    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));

    // Add ribbon icon to toggle chat.
    this.addRibbonIcon(CLAUDE_ICON_NAME, "Claude Code", () => {
      this.activateChatView();
    });

    // Add command to toggle chat sidebar.
    this.addCommand({
      id: "toggle-chat-sidebar",
      name: "Toggle Chat Sidebar",
      callback: () => {
        this.toggleChatView();
      },
    });

    // Add command to open chat sidebar.
    this.addCommand({
      id: "open-chat-sidebar",
      name: "Open Chat Sidebar",
      callback: () => {
        this.activateChatView();
      },
    });

    // Add command to start new conversation.
    this.addCommand({
      id: "new-conversation",
      name: "New Conversation",
      callback: () => {
        this.startNewConversation();
      },
    });

    // Add command to open new chat window.
    this.addCommand({
      id: "new-chat-window",
      name: "New Chat Window",
      callback: () => {
        this.createNewChatView("tab");
      },
    });

    // Register settings tab.
    this.addSettingTab(new ClaudeCodeSettingTab(this.app, this));

    // Ensure chat view exists on layout ready.
    this.app.workspace.onLayoutReady(() => {
      this.initializeClaudeMdFileExplorerIconSync();
      this.refreshClaudeMdFileExplorerIcons();

      const existingLeaf = this.getExistingChatLeaf();
      if (existingLeaf) {
        logger.debug("Plugin", "Chat view restored from workspace layout");
      } else {
        // No existing view - create one in the right sidebar.
        logger.debug("Plugin", "Creating chat view (none existed)");
        this.activateChatView();
      }
    });

    logger.info("Plugin", "Claude Code plugin loaded successfully");
  }

  onunload() {
    this.removeClaudeMdFileExplorerIcons();
    this.claudeMdFileExplorerObserver?.disconnect();
    this.claudeMdFileExplorerObserver = null;
    if (this.claudeMdFileExplorerRefreshTimer !== null) {
      window.clearTimeout(this.claudeMdFileExplorerRefreshTimer);
      this.claudeMdFileExplorerRefreshTimer = null;
    }

    // Clean up chat views.
    this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);
    logger.info("Plugin", "Claude Code plugin unloaded");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (this.settings.storeApiKeyInKeychain) {
      const [apiKey, oauthToken] = await Promise.all([
        getKeychainApiKey(),
        getKeychainOAuthToken(),
      ]);
      if (apiKey) {
        this.runtimeApiKey = apiKey;
      }
      if (oauthToken) {
        this.runtimeOAuthToken = oauthToken;
      }
    } else {
      this.runtimeApiKey = this.settings.apiKey;
      this.runtimeOAuthToken = this.settings.oauthToken;
    }
  }

  async saveSettings() {
    const data = { ...this.settings };
    if (this.settings.storeApiKeyInKeychain) {
      data.apiKey = "";
      data.oauthToken = "";
    }
    await this.saveData(data);
  }

  getClaudeAiPlanUsageSnapshot(): ClaudeAiPlanUsageSnapshot | null {
    return this.claudeAiPlanUsage;
  }

  getClaudeAiPlanUsageError(): string | null {
    return this.claudeAiPlanUsageLastError;
  }

  async refreshClaudeAiPlanUsageIfStale(
    maxAgeMs = 60000,
    opts?: {
      /**
       * When the header is configured to show local spend ("budget"), we still want
       * to allow explicit user-initiated refreshes (eg /usage or a manual refresh click).
       */
      allowWhenBudget?: boolean;
    }
  ): Promise<boolean> {
    const source = this.settings.usageTelemetrySource || "auto";
    if (source === "budget" && !opts?.allowWhenBudget) {
      return false;
    }

    const now = Date.now();
    if (now - this.claudeAiPlanUsageLastFetchedAt < maxAgeMs) {
      return false;
    }

    if (this.claudeAiPlanUsageInFlight) {
      return this.claudeAiPlanUsageInFlight;
    }

    this.claudeAiPlanUsageInFlight = (async () => {
      try {
        const snapshot = await fetchClaudeAiPlanUsage({
          accessToken: this.getOAuthToken() || undefined,
        });
        this.claudeAiPlanUsage = snapshot;
        this.claudeAiPlanUsageLastFetchedAt = now;
        this.claudeAiPlanUsageLastError = null;
        return true;
      } catch (e) {
        this.claudeAiPlanUsageLastFetchedAt = now;
        this.claudeAiPlanUsageLastError = String(e);
        logger.debug("Plugin", "Claude plan usage refresh failed", { error: this.claudeAiPlanUsageLastError });
        // Keep last known snapshot if any.
        return false;
      } finally {
        this.claudeAiPlanUsageInFlight = null;
      }
    })();

    return this.claudeAiPlanUsageInFlight;
  }

  getRollingUsageSummary(windowHours = 5, now = Date.now()) {
    const windowMs = Math.max(1, windowHours) * 60 * 60 * 1000;
    const cutoff = now - windowMs;
    const events = (this.settings.usageEvents || []).filter((event) => event.timestamp >= cutoff);

    return events.reduce(
      (acc, event) => {
        acc.costUsd += event.costUsd;
        acc.inputTokens += event.inputTokens;
        acc.outputTokens += event.outputTokens;
        return acc;
      },
      {
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      }
    );
  }

  async recordUsageEvent(event: UsageEvent) {
    if (!Number.isFinite(event.timestamp) || !Number.isFinite(event.costUsd)) {
      return;
    }

    const now = Date.now();
    const retentionMs = 7 * 24 * 60 * 60 * 1000;
    const cutoff = now - retentionMs;
    const existing = this.settings.usageEvents || [];
    const pruned = existing.filter((entry) => entry.timestamp >= cutoff);

    pruned.push({
      timestamp: event.timestamp,
      costUsd: Math.max(0, event.costUsd),
      inputTokens: Math.max(0, event.inputTokens || 0),
      outputTokens: Math.max(0, event.outputTokens || 0),
    });

    this.settings.usageEvents = pruned;
    await this.saveSettings();
  }

  refreshClaudeMdFileExplorerIcons() {
    if (!this.settings.showClaudeMdFileExplorerIcon) {
      this.removeClaudeMdFileExplorerIcons();
      return;
    }

    this.decorateClaudeMdFileExplorerRows();
  }

  private initializeClaudeMdFileExplorerIconSync() {
    if (this.claudeMdFileExplorerObserver) {
      return;
    }

    const workspaceEl = this.app.workspace.containerEl;
    if (!workspaceEl) {
      return;
    }

    this.claudeMdFileExplorerObserver = new MutationObserver(() => {
      this.scheduleClaudeMdFileExplorerIconRefresh();
    });
    this.claudeMdFileExplorerObserver.observe(workspaceEl, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-path"],
    });

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.scheduleClaudeMdFileExplorerIconRefresh();
      })
    );

    this.register(() => {
      if (this.claudeMdFileExplorerRefreshTimer !== null) {
        window.clearTimeout(this.claudeMdFileExplorerRefreshTimer);
        this.claudeMdFileExplorerRefreshTimer = null;
      }
      this.claudeMdFileExplorerObserver?.disconnect();
      this.claudeMdFileExplorerObserver = null;
    });
  }

  private scheduleClaudeMdFileExplorerIconRefresh() {
    if (this.claudeMdFileExplorerRefreshTimer !== null) {
      return;
    }

    this.claudeMdFileExplorerRefreshTimer = window.setTimeout(() => {
      this.claudeMdFileExplorerRefreshTimer = null;
      this.refreshClaudeMdFileExplorerIcons();
    }, 0);
  }

  private decorateClaudeMdFileExplorerRows() {
    const rows = this.app.workspace.containerEl?.querySelectorAll<HTMLElement>(
      '.workspace-leaf-content[data-type="file-explorer"] .nav-file-title[data-path]'
    );
    if (!rows) {
      return;
    }

    rows.forEach((row) => {
      const path = row.getAttribute("data-path") || "";
      const existingIcon = row.querySelector<HTMLElement>(`.${this.CLAUDE_MD_EXPLORER_ICON_CLASS}`);

      if (!this.isClaudeMdPath(path)) {
        existingIcon?.remove();
        return;
      }

      if (existingIcon) {
        return;
      }

      const iconEl = document.createElement("span");
      iconEl.classList.add(this.CLAUDE_MD_EXPLORER_ICON_CLASS);
      iconEl.setAttribute("aria-hidden", "true");
      setIcon(iconEl, CLAUDE_ICON_NAME);

      const contentEl = row.querySelector<HTMLElement>(".nav-file-title-content");
      if (contentEl) {
        row.insertBefore(iconEl, contentEl);
      } else {
        row.prepend(iconEl);
      }
    });
  }

  private removeClaudeMdFileExplorerIcons() {
    this.app.workspace.containerEl
      ?.querySelectorAll<HTMLElement>(`.${this.CLAUDE_MD_EXPLORER_ICON_CLASS}`)
      .forEach((icon) => icon.remove());
  }

  private isClaudeMdPath(path: string): boolean {
    const fileName = path.split("/").pop();
    return fileName?.toLowerCase() === this.CLAUDE_MD_FILE_NAME;
  }

  // Get existing chat leaf if any.
  getExistingChatLeaf(): WorkspaceLeaf | null {
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
    return leaves.length > 0 ? leaves[0] : null;
  }

  // Activate or create the chat view in right sidebar.
  async activateChatView() {
    const existingLeaf = this.getExistingChatLeaf();

    if (existingLeaf) {
      // Reveal existing leaf.
      this.app.workspace.revealLeaf(existingLeaf);
      return;
    }

    // Create new leaf in right sidebar.
    await this.createNewChatView("tab");
  }

  // Create a new chat view window.
  async createNewChatView(mode: "tab" | "split-right" | "split-down" = "tab") {
    // Check window limit.
    const existingLeaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
    if (existingLeaves.length >= this.MAX_CHAT_WINDOWS) {
      new Notice(`Maximum ${this.MAX_CHAT_WINDOWS} chat windows allowed`);
      return;
    }

    let leaf: WorkspaceLeaf | null = null;

    switch (mode) {
      case "tab":
        leaf = this.app.workspace.getRightLeaf(false);
        break;
      case "split-right": {
        const activeLeaf = this.app.workspace.getActiveViewOfType(ItemView)?.leaf;
        if (activeLeaf) {
          leaf = this.app.workspace.createLeafBySplit(activeLeaf, "vertical");
        } else {
          leaf = this.app.workspace.getRightLeaf(false);
        }
        break;
      }
      case "split-down": {
        const currentLeaf = this.app.workspace.getActiveViewOfType(ItemView)?.leaf;
        if (currentLeaf) {
          leaf = this.app.workspace.createLeafBySplit(currentLeaf, "horizontal");
        } else {
          leaf = this.app.workspace.getRightLeaf(false);
        }
        break;
      }
    }

    if (leaf) {
      await leaf.setViewState({
        type: CHAT_VIEW_TYPE,
        active: true,
      });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  // Toggle chat view visibility by collapsing/expanding the right sidebar.
  async toggleChatView() {
    const existingLeaf = this.getExistingChatLeaf();
    const rightSplit = this.app.workspace.rightSplit;

    if (existingLeaf && rightSplit) {
      if (rightSplit.collapsed) {
        // Sidebar is collapsed, expand it and reveal the chat.
        rightSplit.expand();
        this.app.workspace.revealLeaf(existingLeaf);
      } else {
        // Sidebar is visible, collapse it to hide.
        rightSplit.collapse();
      }
    } else if (!existingLeaf) {
      // No chat view exists, create one.
      await this.activateChatView();
    }
  }

  // Start a new conversation.
  async startNewConversation() {
    const leaf = this.getExistingChatLeaf();
    if (leaf && leaf.view instanceof ChatView) {
      leaf.view.startNewConversation();
    } else {
      // Open chat view first, then start new conversation.
      await this.activateChatView();
      // Small delay to ensure view is ready.
      setTimeout(() => {
        const newLeaf = this.getExistingChatLeaf();
        if (newLeaf && newLeaf.view instanceof ChatView) {
          newLeaf.view.startNewConversation();
        }
      }, 100);
    }
  }

  // Check if authentication is configured (API key or env vars).
  isApiKeyConfigured(): boolean {
    return !!(
      this.getApiKey() ||
      this.getOAuthToken() ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.CLAUDE_CODE_OAUTH_TOKEN
    );
  }

  getApiKey(): string {
    return this.settings.storeApiKeyInKeychain ? this.runtimeApiKey : this.settings.apiKey;
  }

  getOAuthToken(): string {
    return this.settings.storeApiKeyInKeychain ? this.runtimeOAuthToken : this.settings.oauthToken;
  }

  async setApiKey(value: string) {
    this.runtimeApiKey = value;
    if (this.settings.storeApiKeyInKeychain) {
      if (!isKeytarAvailable()) {
        new Notice("Keytar not available. Falling back to settings storage.");
        this.settings.storeApiKeyInKeychain = false;
        this.settings.apiKey = value;
        await this.saveSettings();
        return;
      }
      await setKeychainApiKey(value);
      await this.saveSettings();
      return;
    }
    this.settings.apiKey = value;
    await this.saveSettings();
  }

  async setOAuthToken(value: string) {
    this.runtimeOAuthToken = value;
    if (this.settings.storeApiKeyInKeychain) {
      if (!isKeytarAvailable()) {
        new Notice("Keytar not available. Falling back to settings storage.");
        this.settings.storeApiKeyInKeychain = false;
        this.settings.oauthToken = value;
        await this.saveSettings();
        return;
      }
      await setKeychainOAuthToken(value);
      await this.saveSettings();
      return;
    }
    this.settings.oauthToken = value;
    await this.saveSettings();
  }

  async toggleKeychainStorage(enabled: boolean) {
    if (enabled) {
      if (!isKeytarAvailable()) {
        new Notice("Keytar not available. Install keytar to enable keychain storage.");
        return;
      }
      this.settings.storeApiKeyInKeychain = true;
      await Promise.all([
        this.runtimeApiKey ? setKeychainApiKey(this.runtimeApiKey) : Promise.resolve(),
        this.runtimeOAuthToken ? setKeychainOAuthToken(this.runtimeOAuthToken) : Promise.resolve(),
      ]);
      await this.saveSettings();
    } else {
      this.settings.storeApiKeyInKeychain = false;
      if (this.runtimeApiKey) {
        this.settings.apiKey = this.runtimeApiKey;
      }
      if (this.runtimeOAuthToken) {
        this.settings.oauthToken = this.runtimeOAuthToken;
      }
      await Promise.all([deleteKeychainApiKey(), deleteKeychainOAuthToken()]);
      await this.saveSettings();
    }
  }

  getAuthStatus() {
    const hasEnvOAuthToken = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const hasEnvApiKey = !!process.env.ANTHROPIC_API_KEY;
    const hasStoredApiKey = !!this.getApiKey();
    const hasStoredOAuthToken = !!this.getOAuthToken();
    const hasOAuthToken = hasEnvOAuthToken || hasStoredOAuthToken;
    const source = hasEnvApiKey
      ? "envApiKey"
      : hasStoredApiKey
        ? this.settings.storeApiKeyInKeychain
          ? "keychainApiKey"
          : "settingsApiKey"
        : hasEnvOAuthToken
          ? "envOAuth"
          : hasStoredOAuthToken
            ? this.settings.storeApiKeyInKeychain
              ? "keychainOAuth"
              : "settingsOAuth"
            : "none";
    const labelMap: Record<string, string> = {
      envApiKey: "Env API Key",
      keychainApiKey: "Keychain API Key",
      settingsApiKey: "Settings API Key",
      envOAuth: "Env OAuth",
      keychainOAuth: "Keychain OAuth",
      settingsOAuth: "Settings OAuth",
      none: "Missing",
    };
    return {
      hasOAuthToken,
      hasEnvOAuthToken,
      hasEnvApiKey,
      hasStoredApiKey,
      hasStoredOAuthToken,
      source,
      label: labelMap[source] || "Unknown",
    };
  }

  // Get the vault path.
  getVaultPath(): string {
    const adapter = this.app.vault.adapter as any;
    return adapter.basePath || "";
  }
}
