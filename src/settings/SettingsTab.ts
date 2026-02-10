import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type ClaudeCodePlugin from "../main";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { requireClaudeExecutable } from "../utils/claudeExecutable";
import { isKeytarAvailable } from "../utils/Keychain";

export class ClaudeCodeSettingTab extends PluginSettingTab {
  plugin: ClaudeCodePlugin;

  constructor(app: App, plugin: ClaudeCodePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Claude Code Settings" });

    // API Configuration Section.
    containerEl.createEl("h3", { text: "Authentication" });

    // Check for environment variables.
    const hasEnvApiKey = !!process.env.ANTHROPIC_API_KEY;
    const hasEnvOAuthToken = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;

    if (hasEnvApiKey || hasEnvOAuthToken) {
      const envNotice = containerEl.createDiv({ cls: "claude-code-env-notice" });
      envNotice.createEl("p", {
        text: hasEnvApiKey
          ? "Using API key from ANTHROPIC_API_KEY environment variable."
          : "Using Claude Max subscription via CLAUDE_CODE_OAUTH_TOKEN environment variable.",
        cls: "mod-success",
      });
    }

    const authStatus = this.plugin.getAuthStatus();
    const statusEl = containerEl.createDiv({ cls: "claude-code-auth-status" });
    statusEl.createEl("p", { text: `Auth status: ${authStatus.label}` });

    new Setting(containerEl)
      .setName("API Key")
      .setDesc(
        hasEnvApiKey || hasEnvOAuthToken
          ? "Optional: Override the environment variable with a specific key"
          : "Your Anthropic API key. Get one at console.anthropic.com"
      )
      .addText((text) =>
        text
          .setPlaceholder(hasEnvApiKey ? "(using env var)" : "sk-ant-...")
          .setValue(this.plugin.getApiKey())
          .onChange(async (value) => {
            await this.plugin.setApiKey(value);
          })
      )
      .then((setting) => {
        // Make the input a password field.
        const inputEl = setting.controlEl.querySelector("input");
        if (inputEl) {
          inputEl.type = "password";
        }
      });

    new Setting(containerEl)
      .setName("Claude OAuth Token")
      .setDesc(
        hasEnvOAuthToken || hasEnvApiKey
          ? "Optional: Override environment authentication with a specific OAuth token"
          : "Optional: Paste CLAUDE_CODE_OAUTH_TOKEN here (from 'claude setup-token')"
      )
      .addText((text) =>
        text
          .setPlaceholder(hasEnvOAuthToken ? "(using env var)" : "oauth-token")
          .setValue(this.plugin.getOAuthToken())
          .onChange(async (value) => {
            await this.plugin.setOAuthToken(value);
          })
      )
      .then((setting) => {
        // Make the input a password field.
        const inputEl = setting.controlEl.querySelector("input");
        if (inputEl) {
          inputEl.type = "password";
        }
      });

    // Check for environment variables.
    const hasEnvBaseUrl = !!process.env.ANTHROPIC_BASE_URL;

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc(
        hasEnvBaseUrl
          ? "Optional: Override the environment variable with a specific base URL"
          : "Custom API base URL (e.g., for proxy or custom endpoint)"
      )
      .addText((text) =>
        text
          .setPlaceholder(hasEnvBaseUrl ? "(using env var)" : "https://api.anthropic.com")
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Store secrets in OS keychain")
      .setDesc(isKeytarAvailable() ? "Use the system keychain for API and OAuth tokens" : "Keytar not available")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.storeApiKeyInKeychain).onChange(async (value) => {
          await this.plugin.toggleKeychainStorage(value);
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("Test authentication")
      .setDesc("Runs a lightweight Claude Code SDK call to verify credentials")
      .addButton((button) =>
        button.setButtonText("Test auth").onClick(async () => {
          button.setDisabled(true);
          try {
            const env: Record<string, string | undefined> = { ...process.env };
            const apiKey = this.plugin.getApiKey();
            const oauthToken = this.plugin.getOAuthToken();
            if (apiKey) {
              env.ANTHROPIC_API_KEY = apiKey;
            }
            if (oauthToken) {
              env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
            }
            const claudeExecutable = requireClaudeExecutable();
            const vaultPath = this.plugin.getVaultPath();
            for await (const message of query({
              prompt: "ping",
              options: {
                cwd: vaultPath,
                env,
                pathToClaudeCodeExecutable: claudeExecutable,
                model: this.plugin.settings.model || "sonnet",
                includePartialMessages: false,
                maxTurns: 1,
                maxBudgetUsd: 0.01,
              },
            })) {
              if (message.type === "result" && message.subtype === "success") {
                new Notice("Authentication succeeded");
                break;
              }
            }
          } catch (error) {
            new Notice(`Auth test failed: ${String(error)}`);
          } finally {
            button.setDisabled(false);
          }
        })
      );

    // Claude Max subscription info.
    const authInfoEl = containerEl.createDiv({ cls: "claude-code-auth-info" });
    authInfoEl.createEl("details", {}, (details) => {
      details.createEl("summary", { text: "Using Claude Max subscription?" });
      details.createEl("p", {
        text: "If you have a Claude Pro or Max subscription, you can use it instead of an API key:",
      });
      const steps = details.createEl("ol");
      steps.createEl("li", {
        text: "Run 'claude setup-token' in your terminal to authenticate with your subscription",
      });
      steps.createEl("li", {
        text: "Paste the generated token into 'Claude OAuth Token' above OR export CLAUDE_CODE_OAUTH_TOKEN",
      });
      steps.createEl("li", { text: "If using environment variables, restart Obsidian to pick up the token" });
      details.createEl("p", {
        text: "Note: If ANTHROPIC_API_KEY is also set, the API key takes precedence.",
        cls: "mod-warning",
      });
    });

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Claude model to use for conversations")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("sonnet", "Sonnet (Faster)")
          .addOption("opus", "Opus (More capable)")
          .addOption("haiku", "Haiku (Fastest)")
          .setValue(this.plugin.settings.model || "sonnet")
          .onChange(async (value) => {
            this.plugin.settings.model = value;
            await this.plugin.saveSettings();
          })
      );

    // Permissions Section.
    containerEl.createEl("h3", { text: "Permissions" });

    new Setting(containerEl)
      .setName("Auto-approve vault reads")
      .setDesc("Automatically allow Claude to read files in your vault")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoApproveVaultReads).onChange(async (value) => {
          this.plugin.settings.autoApproveVaultReads = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Auto-approve vault writes")
      .setDesc("Automatically allow Claude to create and edit files in your vault")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoApproveVaultWrites).onChange(async (value) => {
          this.plugin.settings.autoApproveVaultWrites = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Review edits with diff")
      .setDesc("Show a unified diff before applying edits")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.reviewEditsWithDiff).onChange(async (value) => {
          this.plugin.settings.reviewEditsWithDiff = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Require approval for commands")
      .setDesc("Require explicit approval before executing shell commands")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.requireBashApproval).onChange(async (value) => {
          this.plugin.settings.requireBashApproval = value;
          await this.plugin.saveSettings();
        })
      );

    // Always-allowed tools section.
    if (this.plugin.settings.alwaysAllowedTools.length > 0) {
      const alwaysAllowedEl = containerEl.createDiv({ cls: "claude-code-always-allowed" });
      alwaysAllowedEl.createEl("h4", { text: "Always Allowed Tools" });
      alwaysAllowedEl.createEl("p", {
        text: "These tools have been permanently approved. Click to remove.",
        cls: "setting-item-description",
      });

      const toolsList = alwaysAllowedEl.createDiv({ cls: "claude-code-tools-list" });
      for (const tool of this.plugin.settings.alwaysAllowedTools) {
        const toolChip = toolsList.createDiv({ cls: "claude-code-tool-chip" });
        toolChip.createSpan({ text: tool });
        const removeBtn = toolChip.createEl("button", { text: "×", cls: "claude-code-tool-chip-remove" });
        removeBtn.addEventListener("click", async () => {
          this.plugin.settings.alwaysAllowedTools = this.plugin.settings.alwaysAllowedTools.filter(
            (t) => t !== tool
          );
          await this.plugin.saveSettings();
          this.display(); // Re-render settings.
        });
      }
    }

    // Agent SDK Section.
    containerEl.createEl("h3", { text: "Agent Settings" });

    new Setting(containerEl)
      .setName("Max budget per session")
      .setDesc("Maximum cost in USD before requiring confirmation to continue")
      .addText((text) =>
        text
          .setPlaceholder("10.00")
          .setValue(String(this.plugin.settings.maxBudgetPerSession))
          .onChange(async (value) => {
            const parsed = parseFloat(value);
            if (!isNaN(parsed) && parsed > 0) {
              this.plugin.settings.maxBudgetPerSession = parsed;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Max turns per query")
      .setDesc("Maximum conversation turns (tool use cycles) per query")
      .addText((text) =>
        text
          .setPlaceholder("50")
          .setValue(String(this.plugin.settings.maxTurns))
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            if (!isNaN(parsed) && parsed > 0) {
              this.plugin.settings.maxTurns = parsed;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Show project controls panel")
      .setDesc("Display model, budget, skills, and context controls above chat")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showProjectControlsPanel).onChange(async (value) => {
          this.plugin.settings.showProjectControlsPanel = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Max pinned context characters")
      .setDesc("Limit for pinned context injected into the prompt")
      .addText((text) =>
        text
          .setPlaceholder("8000")
          .setValue(String(this.plugin.settings.maxPinnedContextChars))
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            if (!isNaN(parsed) && parsed > 0) {
              this.plugin.settings.maxPinnedContextChars = parsed;
              await this.plugin.saveSettings();
            }
          })
      );

    // MCP servers section.
    containerEl.createEl("h3", { text: "MCP Servers (Advanced)" });

    const mcpInfo = containerEl.createDiv({ cls: "claude-code-mcp-info" });
    mcpInfo.createEl("p", {
      text: "Additional MCP servers require explicit approval before they are enabled.",
    });

    const mcpList = containerEl.createDiv({ cls: "claude-code-mcp-list" });
    for (const server of this.plugin.settings.additionalMcpServers) {
      const item = mcpList.createDiv({ cls: "claude-code-mcp-item" });
      item.createSpan({ text: server.name });
      const status = item.createSpan({ cls: "claude-code-mcp-status" });
      const approved = this.plugin.settings.approvedMcpServers.includes(server.name);
      status.setText(server.enabled ? (approved ? "enabled" : "needs approval") : "disabled");
      const toggle = item.createEl("button", { text: approved ? "Revoke" : "Approve" });
      toggle.addEventListener("click", async () => {
        if (approved) {
          this.plugin.settings.approvedMcpServers = this.plugin.settings.approvedMcpServers.filter(
            (name) => name !== server.name
          );
        } else {
          this.plugin.settings.approvedMcpServers.push(server.name);
        }
        await this.plugin.saveSettings();
        this.display();
      });
    }

    new Setting(containerEl)
      .setName("Additional MCP servers JSON")
      .setDesc("Edit the MCP server configuration array directly")
      .addTextArea((text) =>
        text
          .setPlaceholder('[{"name":"my-server","command":"node","args":["server.js"],"enabled":false}]')
          .setValue(JSON.stringify(this.plugin.settings.additionalMcpServers, null, 2))
          .onChange(async (value) => {
            try {
              const parsed = JSON.parse(value);
              if (Array.isArray(parsed)) {
                this.plugin.settings.additionalMcpServers = parsed;
                await this.plugin.saveSettings();
              }
            } catch {
              // Ignore invalid JSON until fixed.
            }
          })
      );

    // About Section.
    containerEl.createEl("h3", { text: "About" });

    const aboutEl = containerEl.createDiv({ cls: "claude-code-settings-about" });
    aboutEl.createEl("p", {
      text: "Claude Code brings AI-powered assistance to your Obsidian vault using the Claude Agent SDK. Ask questions, automate tasks, search notes semantically, and get help with your knowledge base.",
    });
    aboutEl.createEl("p", {
      text: "Features: Built-in tools (Read, Write, Bash, Grep), skill loading from .claude/skills/, Obsidian-specific tools (open files, run commands), and semantic vault search.",
    });
  }
}
