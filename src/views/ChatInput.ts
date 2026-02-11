import { setIcon } from "obsidian";
import type ClaudeCodePlugin from "../main";
import { AutocompletePopup } from "./AutocompletePopup";
import { logger } from "../utils/Logger";
import type { Suggestion } from "../utils/autocomplete";
import {
  getSlashCommandByValue,
  getSlashCommandInputText,
  parseSlashCommandInput,
  type SlashCommandDefinition,
} from "../utils/slashCommands";
import type { SlashCommandTelemetryAction } from "../types";

interface ChatInputOptions {
  onSend: (message: string) => void;
  onCancel: () => void;
  isStreaming: () => boolean;
  onCommand?: (command: string, args: string[]) => void;
  getAdditionalCommandSuggestions?: () => Suggestion[];
  plugin: ClaudeCodePlugin;
}

export interface ChatInputHint {
  id: string;
  text: string;
  command: string;
  severity?: "info" | "warning";
  onDismiss?: (hintId: string) => void;
}

export class ChatInput {
  private containerEl: HTMLElement;
  private textareaEl!: HTMLTextAreaElement;
  private options: ChatInputOptions;
  private fileContexts: string[] = [];
  private autocomplete: AutocompletePopup;
  private hints: ChatInputHint[] = [];
  private hintsEl: HTMLElement | null = null;

  constructor(parentEl: HTMLElement, options: ChatInputOptions) {
    this.containerEl = parentEl;
    this.options = options;

    // Create autocomplete popup.
    this.autocomplete = new AutocompletePopup(options.plugin, (suggestion) => {
      if (suggestion.type === "command") {
        const command = getSlashCommandByValue(suggestion.value);
        if (command) {
          this.handleCommand(command);
        } else {
          const hasArgumentHint =
            suggestion.label.trim().startsWith(suggestion.value) &&
            suggestion.label.trim() !== suggestion.value;
          this.textareaEl.value = hasArgumentHint ? `${suggestion.value} ` : suggestion.value;
          this.textareaEl.selectionStart = this.textareaEl.selectionEnd = this.textareaEl.value.length;
          this.textareaEl.focus();
        }
      } else {
        this.insertFileMention(suggestion.value);
      }
    }, {
      getCommandSuggestions: options.getAdditionalCommandSuggestions,
    });

    this.render();
  }

  private render() {
    // Input wrapper.
    const wrapperEl = this.containerEl.createDiv({ cls: "claude-code-input-wrapper" });

    // Textarea.
    this.textareaEl = wrapperEl.createEl("textarea", {
      cls: "claude-code-input",
      attr: {
        placeholder: "Ask about your vault...",
        rows: "1",
      },
    });

    // Auto-resize textarea.
    this.textareaEl.addEventListener("input", () => {
      this.autoResize();
      this.checkForAutocomplete();
    });

    // Handle keyboard shortcuts.
    this.textareaEl.addEventListener("keydown", (e) => this.handleKeydown(e));

    // Hide autocomplete on blur.
    this.textareaEl.addEventListener("blur", () => {
      // Delay to allow click on autocomplete item.
      setTimeout(() => this.autocomplete.hide(), 200);
    });

  }

  private handleKeydown(e: KeyboardEvent) {
    logger.debug("ChatInput", "Keydown event", { key: e.key, shiftKey: e.shiftKey });

    // Let autocomplete handle navigation keys.
    if (this.autocomplete.isVisible() && this.autocomplete.handleKeydown(e)) {
      return;
    }

    // Send on Enter (without Shift).
    if (e.key === "Enter" && !e.shiftKey) {
      logger.info("ChatInput", "Enter pressed, calling handleSend", { isStreaming: this.options.isStreaming() });
      e.preventDefault();
      if (this.options.isStreaming()) {
        this.options.onCancel();
      } else {
        this.handleSend();
      }
      return;
    }

    // Cancel on Escape.
    if (e.key === "Escape") {
      if (this.autocomplete.isVisible()) {
        e.preventDefault();
        this.autocomplete.hide();
      } else if (this.options.isStreaming()) {
        e.preventDefault();
        this.options.onCancel();
      }
      return;
    }
  }

  private checkForAutocomplete() {
    const value = this.textareaEl.value;
    const cursorPos = this.textareaEl.selectionStart;

    // Check for slash command at start.
    if (value.startsWith("/")) {
      const query = value.slice(1, cursorPos);
      this.showAutocomplete("command", query);
      return;
    }

    // Check for @ mention.
    const beforeCursor = value.slice(0, cursorPos);
    const atIndex = beforeCursor.lastIndexOf("@");
    if (atIndex !== -1) {
      const afterAt = beforeCursor.slice(atIndex + 1);
      // Only show if there's no space after @.
      if (!afterAt.includes(" ")) {
        this.showAutocomplete("file", afterAt);
        return;
      }
    }

    this.autocomplete.hide();
  }

  private showAutocomplete(type: "command" | "file", query = "") {
    this.autocomplete.show(this.textareaEl, type, query);
  }

  private handleCommand(command: SlashCommandDefinition) {
    this.recordSlashCommandEvent(command, "selected", "autocomplete", 0);
    this.textareaEl.value = getSlashCommandInputText(command);
    this.textareaEl.selectionStart = this.textareaEl.selectionEnd = this.textareaEl.value.length;
    this.textareaEl.focus();
  }

  private applyHintCommand(commandText: string) {
    const trimmed = commandText.trim();
    if (!trimmed) return;

    const [commandToken] = trimmed.split(/\s+/);
    const knownCommand = getSlashCommandByValue(commandToken.toLowerCase());
    const value =
      knownCommand && trimmed === commandToken
        ? getSlashCommandInputText(knownCommand)
        : trimmed;

    this.textareaEl.value = value;
    this.textareaEl.selectionStart = this.textareaEl.selectionEnd = this.textareaEl.value.length;
    this.autoResize();
    this.checkForAutocomplete();
    this.textareaEl.focus();
  }

  private insertFileMention(path: string) {
    const value = this.textareaEl.value;
    const cursorPos = this.textareaEl.selectionStart;

    // Find the @ that triggered this.
    const beforeCursor = value.slice(0, cursorPos);
    const atIndex = beforeCursor.lastIndexOf("@");

    if (atIndex !== -1) {
      // Replace from @ to cursor with the file mention.
      const newValue = value.slice(0, atIndex) + `@[[${path}]]` + value.slice(cursorPos);
      this.textareaEl.value = newValue;
      this.textareaEl.selectionStart = this.textareaEl.selectionEnd = atIndex + path.length + 5;
    } else {
      // Just append.
      this.insertAtCursor(`@[[${path}]]`);
    }

    this.textareaEl.focus();
  }

  private handleSend() {
    logger.info("ChatInput", "handleSend called");
    const message = this.textareaEl.value.trim();
    logger.debug("ChatInput", "Message content", { length: message.length, preview: message.slice(0, 50) });

    if (!message) {
      logger.warn("ChatInput", "Empty message, not sending");
      return;
    }

    const parsed = parseSlashCommandInput(message);
    if (parsed && parsed.command.handler === "local") {
      this.options.onCommand?.(parsed.command.id, parsed.args);
      this.recordSlashCommandEvent(parsed.command, "executedLocal", "typed", parsed.args.length);
      this.textareaEl.value = "";
      this.autoResize();
      this.autocomplete.hide();
      logger.info("ChatInput", "Executed local slash command", {
        command: parsed.command.id,
        args: parsed.args,
      });
      return;
    }

    if (parsed && parsed.command.handler === "sendToClaude") {
      this.recordSlashCommandEvent(parsed.command, "submittedToClaude", "typed", parsed.args.length);
    }

    // Include file contexts in message if any.
    let fullMessage = message;
    if (this.fileContexts.length > 0) {
      const contextPrefix = this.fileContexts.map((f) => `@[[${f}]]`).join(" ");
      fullMessage = `${contextPrefix}\n\n${message}`;
      this.fileContexts = [];
      this.updateContextChips();
    }
    fullMessage = this.resolveStandaloneAtMention(fullMessage);

    logger.info("ChatInput", "Calling onSend callback", { fullMessageLength: fullMessage.length });
    this.options.onSend(fullMessage);
    this.textareaEl.value = "";
    this.autoResize();
    this.autocomplete.hide();
    logger.info("ChatInput", "handleSend completed");
  }

  addFileContext(path: string) {
    if (!this.fileContexts.includes(path)) {
      this.fileContexts.push(path);
      this.updateContextChips();
    }
  }

  private updateContextChips() {
    // Remove existing chips.
    const existingChips = this.containerEl.querySelector(".claude-code-context-chips");
    if (existingChips) {
      existingChips.remove();
    }

    if (this.fileContexts.length === 0) return;

    // Add context chips at the top of the input area.
    const chipsEl = this.containerEl.createDiv({ cls: "claude-code-context-chips" });
    this.containerEl.insertBefore(chipsEl, this.containerEl.firstChild);

    for (const path of this.fileContexts) {
      const chipEl = chipsEl.createDiv({ cls: "claude-code-context-chip" });
      chipEl.createSpan({ text: path.split("/").pop() || path });

      const removeBtn = chipEl.createSpan({ cls: "claude-code-context-chip-remove" });
      setIcon(removeBtn, "x");
      removeBtn.addEventListener("click", () => {
        this.fileContexts = this.fileContexts.filter((f) => f !== path);
        this.updateContextChips();
      });
    }
  }

  private insertAtCursor(text: string) {
    const start = this.textareaEl.selectionStart;
    const end = this.textareaEl.selectionEnd;
    const value = this.textareaEl.value;
    this.textareaEl.value = value.slice(0, start) + text + value.slice(end);
    this.textareaEl.selectionStart = this.textareaEl.selectionEnd = start + text.length;
    this.textareaEl.focus();
  }

  private autoResize() {
    this.textareaEl.style.height = "auto";
    this.textareaEl.style.height = Math.min(this.textareaEl.scrollHeight, 200) + "px";
  }

  private resolveStandaloneAtMention(message: string): string {
    const activeFile = this.options.plugin.app.workspace.getActiveFile();
    if (!activeFile?.path) {
      return message;
    }

    const activeMention = `@[[${activeFile.path}]]`;
    // Convert bare "@" tokens (eg "@ hello") to the active-file mention.
    // Keep "@foo" and existing "@[[...]]" mentions unchanged.
    return message.replace(/(^|\s)@(?!\[\[)(?=\s|$)/g, `$1${activeMention}`);
  }

  updateState() {
    const streaming = this.options.isStreaming();

    if (streaming) {
      this.textareaEl.placeholder = "Press Escape to cancel...";
    } else {
      this.textareaEl.placeholder = "Ask about your vault...";
    }
  }

  focus() {
    this.textareaEl.focus();
  }

  getValue(): string {
    return this.textareaEl.value;
  }

  setValue(value: string) {
    this.textareaEl.value = value;
    this.autoResize();
  }

  setHints(hints: ChatInputHint[]) {
    this.hints = [...hints];
    this.renderHints();
  }

  private renderHints() {
    this.hintsEl?.remove();
    this.hintsEl = null;

    if (this.hints.length === 0) {
      return;
    }

    this.hintsEl = this.containerEl.createDiv({ cls: "claude-code-input-hints" });

    for (const hint of this.hints) {
      const chipEl = this.hintsEl.createDiv({
        cls: `claude-code-input-hint-chip${hint.severity === "warning" ? " is-warning" : ""}`,
      });

      const actionEl = chipEl.createEl("button", {
        cls: "claude-code-input-hint-action",
        text: hint.text,
        attr: { type: "button" },
      });
      actionEl.addEventListener("click", () => this.applyHintCommand(hint.command));

      const dismissEl = chipEl.createEl("button", {
        cls: "claude-code-input-hint-dismiss",
        attr: {
          type: "button",
          "aria-label": `Dismiss hint: ${hint.text}`,
        },
      });
      setIcon(dismissEl, "x");
      dismissEl.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        hint.onDismiss?.(hint.id);
      });
    }
  }

  private recordSlashCommandEvent(
    command: SlashCommandDefinition,
    action: SlashCommandTelemetryAction,
    source: "typed" | "autocomplete",
    argsCount: number
  ) {
    void this.options.plugin.recordSlashCommandEvent({
      timestamp: Date.now(),
      commandId: command.id,
      command: command.command,
      telemetryKey: command.telemetryKey,
      handler: command.handler,
      action,
      source,
      argsCount,
    }).catch((error: unknown) => {
      logger.warn("ChatInput", "Failed to record slash command telemetry", {
        commandId: command.id,
        action,
        source,
        error: String(error),
      });
    });
  }
}
