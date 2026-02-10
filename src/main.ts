import { Plugin, WorkspaceLeaf, Notice, ItemView } from "obsidian";
import { ClaudeCodeSettings, DEFAULT_SETTINGS, CHAT_VIEW_TYPE } from "./types";
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

export default class ClaudeCodePlugin extends Plugin {
  settings: ClaudeCodeSettings = DEFAULT_SETTINGS;
  private readonly MAX_CHAT_WINDOWS = 5;
  private runtimeApiKey = "";
  private runtimeOAuthToken = "";

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
