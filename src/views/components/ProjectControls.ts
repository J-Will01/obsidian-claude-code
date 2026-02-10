import { App, Notice, setIcon, MarkdownView } from "obsidian";
import type ClaudeCodePlugin from "../../main";
import type { ConversationManager } from "../../agent/ConversationManager";
import { MessageContext } from "../../types";

type ProjectControlsOptions = {
  containerEl: HTMLElement;
  app: App;
  plugin: ClaudeCodePlugin;
  conversationManager: ConversationManager;
  onResetSession: () => void;
  onOpenLogs: () => void;
};

export class ProjectControls {
  private containerEl: HTMLElement;
  private app: App;
  private plugin: ClaudeCodePlugin;
  private conversationManager: ConversationManager;
  private onResetSession: () => void;
  private onOpenLogs: () => void;

  constructor(options: ProjectControlsOptions) {
    this.containerEl = options.containerEl;
    this.app = options.app;
    this.plugin = options.plugin;
    this.conversationManager = options.conversationManager;
    this.onResetSession = options.onResetSession;
    this.onOpenLogs = options.onOpenLogs;
  }

  render() {
    this.containerEl.empty();
    this.containerEl.addClass("claude-code-project-controls");

    const header = this.containerEl.createDiv({ cls: "claude-code-project-controls-header" });
    const title = header.createSpan({ text: "Project Controls" });
    title.addClass("claude-code-project-controls-title");

    const modelRow = this.containerEl.createDiv({ cls: "claude-code-project-controls-row" });
    modelRow.createSpan({ text: "Model" });
    const modelSelect = modelRow.createEl("select");
    modelSelect.add(new Option("Sonnet", "sonnet"));
    modelSelect.add(new Option("Opus", "opus"));
    modelSelect.add(new Option("Haiku", "haiku"));
    modelSelect.value = this.plugin.settings.model || "sonnet";
    modelSelect.addEventListener("change", async () => {
      this.plugin.settings.model = modelSelect.value;
      await this.plugin.saveSettings();
    });

    const budgetRow = this.containerEl.createDiv({ cls: "claude-code-project-controls-row" });
    budgetRow.createSpan({ text: "Budget ($)" });
    const budgetInput = budgetRow.createEl("input", { attr: { type: "number", step: "0.5", min: "0" } });
    budgetInput.value = String(this.plugin.settings.maxBudgetPerSession);
    budgetInput.addEventListener("change", async () => {
      const parsed = parseFloat(budgetInput.value);
      if (!Number.isNaN(parsed)) {
        this.plugin.settings.maxBudgetPerSession = parsed;
        await this.plugin.saveSettings();
      }
    });

    const turnsRow = this.containerEl.createDiv({ cls: "claude-code-project-controls-row" });
    turnsRow.createSpan({ text: "Max turns" });
    const turnsInput = turnsRow.createEl("input", { attr: { type: "number", step: "1", min: "1" } });
    turnsInput.value = String(this.plugin.settings.maxTurns);
    turnsInput.addEventListener("change", async () => {
      const parsed = parseInt(turnsInput.value, 10);
      if (!Number.isNaN(parsed)) {
        this.plugin.settings.maxTurns = parsed;
        await this.plugin.saveSettings();
      }
    });

    const permissionRow = this.containerEl.createDiv({ cls: "claude-code-project-controls-row" });
    permissionRow.createSpan({ text: "Permissions" });
    const permissionSelect = permissionRow.createEl("select");
    permissionSelect.add(new Option("Default", "default"));
    permissionSelect.add(new Option("Accept Edits", "acceptEdits"));
    permissionSelect.add(new Option("Plan", "plan"));
    permissionSelect.add(new Option("Bypass", "bypassPermissions"));
    permissionSelect.value = this.plugin.settings.permissionMode || "default";
    permissionSelect.addEventListener("change", async () => {
      this.plugin.settings.permissionMode = permissionSelect.value as
        | "default"
        | "acceptEdits"
        | "plan"
        | "bypassPermissions";
      await this.plugin.saveSettings();
    });

    const authRow = this.containerEl.createDiv({ cls: "claude-code-project-controls-row" });
    authRow.createSpan({ text: "Auth" });
    const authBadge = authRow.createSpan({ cls: "claude-code-project-controls-badge" });
    authBadge.setText(this.plugin.getAuthStatus().label);

    const skillsRow = this.containerEl.createDiv({ cls: "claude-code-project-controls-row" });
    skillsRow.createSpan({ text: "Skills" });
    const skillsBadge = skillsRow.createSpan({ cls: "claude-code-project-controls-badge" });
    this.loadSkills().then((skills) => {
      skillsBadge.setText(`${skills.length} loaded`);
      if (skills.length > 0) {
        skillsBadge.setAttribute("title", skills.join("\n"));
      }
    });

    const mcpRow = this.containerEl.createDiv({ cls: "claude-code-project-controls-row" });
    mcpRow.createSpan({ text: "MCP" });
    const mcpBadge = mcpRow.createSpan({ cls: "claude-code-project-controls-badge" });
    const activeServers = this.getActiveMcpServers();
    mcpBadge.setText(activeServers.length > 0 ? activeServers.join(", ") : "obsidian");

    const buttons = this.containerEl.createDiv({ cls: "claude-code-project-controls-actions" });
    this.addActionButton(buttons, "file-text", "Add active file", () => this.addActiveFile());
    this.addActionButton(buttons, "mouse-pointer-2", "Add selection", () => this.addSelection());
    this.addActionButton(buttons, "link", "Add backlinks", () => this.addBacklinks());
    this.addActionButton(buttons, "rotate-ccw", "Reset session", this.onResetSession);
    this.addActionButton(buttons, "file-search", "Open logs", this.onOpenLogs);

    const pinnedContext = this.conversationManager.getPinnedContext();
    if (pinnedContext.length > 0) {
      const pinnedSection = this.containerEl.createDiv({ cls: "claude-code-project-controls-pinned" });
      pinnedSection.createDiv({ text: "Pinned context" });
      const list = pinnedSection.createEl("ul");
      for (const ctx of pinnedContext) {
        const item = list.createEl("li");
        item.setText(ctx.label);
      }
    }
  }

  private addActionButton(container: HTMLElement, icon: string, label: string, onClick: () => void) {
    const button = container.createEl("button", { attr: { "aria-label": label } });
    setIcon(button.createSpan(), icon);
    button.addEventListener("click", onClick);
  }

  private async addActiveFile() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active file to add.");
      return;
    }
    const content = await this.app.vault.read(file);
    await this.addPinnedContext({
      type: "file",
      path: file.path,
      content,
      label: `File: ${file.path}`,
    });
  }

  private async addSelection() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = view?.editor;
    const selection = editor?.getSelection();
    if (!selection) {
      new Notice("No selection to add.");
      return;
    }
    await this.addPinnedContext({
      type: "selection",
      content: selection,
      label: "Selection",
    });
  }

  private async addPinnedContext(context: MessageContext) {
    await this.conversationManager.addPinnedContext(context);
    this.render();
  }

  private async addBacklinks() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active file to find backlinks for.");
      return;
    }
    const backlinks = (this.app.metadataCache as any).getBacklinksForFile?.(file);
    const linkedFiles: string[] = backlinks
      ? Array.from(backlinks.data?.keys?.() ?? []).map((entry: any) => {
        if (typeof entry === "string") return entry;
        if (entry?.path) return entry.path;
        return "";
      }).filter(Boolean)
      : [];
    if (linkedFiles.length === 0) {
      new Notice("No backlinks found.");
      return;
    }
    const limited = linkedFiles.slice(0, 3);
    for (const path of limited) {
      const target = this.app.vault.getAbstractFileByPath(path);
      if (target && "path" in target) {
        const content = await this.app.vault.adapter.read(target.path);
        await this.conversationManager.addPinnedContext({
          type: "file",
          path: target.path,
          content,
          label: `Backlink: ${target.path}`,
        });
      }
    }
    this.render();
  }

  private async loadSkills(): Promise<string[]> {
    const skillsPath = ".claude/skills";
    const adapter = this.app.vault.adapter;
    const exists = await adapter.exists(skillsPath);
    if (!exists) return [];

    const listing = await adapter.list(skillsPath);
    const folders = listing.folders.map((folder) => folder.split("/").pop() || folder);
    const skills: string[] = [];
    for (const folder of folders) {
      const skillFile = `${skillsPath}/${folder}/SKILL.md`;
      if (await adapter.exists(skillFile)) {
        skills.push(folder);
      }
    }
    return skills;
  }

  private getActiveMcpServers(): string[] {
    return this.plugin.settings.additionalMcpServers
      .filter((server) => server.enabled && this.plugin.settings.approvedMcpServers.includes(server.name))
      .map((server) => server.name);
  }
}
