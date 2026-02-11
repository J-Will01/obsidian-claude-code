import type { Suggestion } from "./autocomplete";

export type SlashCommandHandler = "local" | "sendToClaude";

export interface SlashCommandDefinition {
  id: string;
  command: `/${string}`;
  description: string;
  argumentHint?: string;
  icon: string;
  handler: SlashCommandHandler;
  telemetryKey: string;
}

export interface ExternalSlashCommandDefinition {
  name: string;
  description: string;
  argumentHint: string;
}

export type ExternalSlashCommandOrigin = "sdk" | "project" | "personal" | "mcp";

const COMMAND_DEFINITIONS: SlashCommandDefinition[] = [
  {
    id: "help",
    command: "/help",
    description: "Show available commands and tools",
    icon: "help-circle",
    handler: "local",
    telemetryKey: "slash_help",
  },
  {
    id: "clear",
    command: "/clear",
    description: "Clear conversation history",
    icon: "trash-2",
    handler: "local",
    telemetryKey: "slash_clear",
  },
  {
    id: "new",
    command: "/new",
    description: "Start a new conversation",
    icon: "plus",
    handler: "local",
    telemetryKey: "slash_new",
  },
  {
    id: "file",
    command: "/file",
    description: "Add active file (or a path) as @ context",
    argumentHint: "[path]",
    icon: "file-text",
    handler: "local",
    telemetryKey: "slash_file",
  },
  {
    id: "rename",
    command: "/rename",
    description: "Rename the current conversation",
    argumentHint: "[title]",
    icon: "pencil",
    handler: "local",
    telemetryKey: "slash_rename",
  },
  {
    id: "pin-file",
    command: "/pin-file",
    description: "Pin active file contents into prompt context",
    icon: "pin",
    handler: "local",
    telemetryKey: "slash_pin_file",
  },
  {
    id: "pin-selection",
    command: "/pin-selection",
    description: "Pin selected editor text into prompt context",
    icon: "highlighter",
    handler: "local",
    telemetryKey: "slash_pin_selection",
  },
  {
    id: "pin-backlinks",
    command: "/pin-backlinks",
    description: "Pin up to N backlink files from active note",
    argumentHint: "[count]",
    icon: "link",
    handler: "local",
    telemetryKey: "slash_pin_backlinks",
  },
  {
    id: "pins",
    command: "/pins",
    description: "Show pinned context items",
    icon: "list",
    handler: "local",
    telemetryKey: "slash_pins",
  },
  {
    id: "clear-pins",
    command: "/clear-pins",
    description: "Clear all pinned context items",
    icon: "list-x",
    handler: "local",
    telemetryKey: "slash_clear_pins",
  },
  {
    id: "logs",
    command: "/logs",
    description: "Open plugin logs in your OS",
    icon: "file-search",
    handler: "local",
    telemetryKey: "slash_logs",
  },
  {
    id: "search",
    command: "/search",
    description: "Search vault for text",
    argumentHint: "[query]",
    icon: "search",
    handler: "sendToClaude",
    telemetryKey: "slash_search",
  },
  {
    id: "context",
    command: "/context",
    description: "Show current context",
    icon: "info",
    handler: "local",
    telemetryKey: "slash_context",
  },
  {
    id: "status",
    command: "/status",
    description: "Show session status",
    icon: "activity",
    handler: "local",
    telemetryKey: "slash_status",
  },
  {
    id: "doctor",
    command: "/doctor",
    description: "Run diagnostics and suggested fixes",
    icon: "wrench",
    handler: "local",
    telemetryKey: "slash_doctor",
  },
  {
    id: "cost",
    command: "/cost",
    description: "Show conversation token and cost usage",
    icon: "wallet",
    handler: "local",
    telemetryKey: "slash_cost",
  },
  {
    id: "usage",
    command: "/usage",
    description: "Show Claude plan usage (5-hour and 7-day)",
    icon: "bar-chart-2",
    handler: "local",
    telemetryKey: "slash_usage",
  },
  {
    id: "model",
    command: "/model",
    description: "Show or change the active model",
    argumentHint: "[name]",
    icon: "cpu",
    handler: "local",
    telemetryKey: "slash_model",
  },
  {
    id: "permissions",
    command: "/permissions",
    description: "Show permission settings",
    icon: "shield",
    handler: "local",
    telemetryKey: "slash_permissions",
  },
  {
    id: "mcp",
    command: "/mcp",
    description: "Show MCP server status",
    icon: "plug",
    handler: "local",
    telemetryKey: "slash_mcp",
  },
  {
    id: "rewind",
    command: "/rewind",
    description: "Restore most recent backup",
    icon: "rotate-ccw",
    handler: "local",
    telemetryKey: "slash_rewind",
  },
  {
    id: "checkpoint",
    command: "/checkpoint",
    description: "List rewind checkpoints",
    icon: "history",
    handler: "local",
    telemetryKey: "slash_checkpoint",
  },
];

const COMMAND_BY_ID = new Map<string, SlashCommandDefinition>(
  COMMAND_DEFINITIONS.map((cmd) => [cmd.id, cmd])
);

const COMMAND_BY_NAME = new Map<string, SlashCommandDefinition>(
  COMMAND_DEFINITIONS.map((cmd) => [cmd.command.slice(1), cmd])
);

const COMMAND_BY_VALUE = new Map<string, SlashCommandDefinition>(
  COMMAND_DEFINITIONS.map((cmd) => [cmd.command, cmd])
);

export function getSlashCommands(): SlashCommandDefinition[] {
  return [...COMMAND_DEFINITIONS];
}

export function getSlashCommandById(id: string): SlashCommandDefinition | null {
  return COMMAND_BY_ID.get(id) ?? null;
}

export function getSlashCommandByValue(value: string): SlashCommandDefinition | null {
  return COMMAND_BY_VALUE.get(value.toLowerCase()) ?? null;
}

export function getSlashCommandSuggestions(): Suggestion[] {
  return COMMAND_DEFINITIONS.map((cmd) => ({
    type: "command" as const,
    value: cmd.command,
    label: cmd.argumentHint ? `${cmd.command} ${cmd.argumentHint}` : cmd.command,
    description: cmd.description,
    icon: cmd.icon,
    origin: "local",
  }));
}

export function normalizeSlashCommandName(name: string): string {
  const trimmed = String(name || "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function getExternalSlashCommandOrigin(name: string): ExternalSlashCommandOrigin {
  const normalized = normalizeSlashCommandName(name).toLowerCase();
  if (normalized.startsWith("/project:")) {
    return "project";
  }
  if (normalized.startsWith("/user:")) {
    return "personal";
  }
  if (normalized.startsWith("/mcp") || normalized.includes("mcp")) {
    return "mcp";
  }
  return "sdk";
}

export function getExternalSlashCommandSuggestions(
  commands: ExternalSlashCommandDefinition[]
): Suggestion[] {
  const seen = new Set<string>();
  const suggestions: Suggestion[] = [];

  for (const command of commands) {
    const value = normalizeSlashCommandName(command.name);
    if (!value) continue;

    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const argumentHint = String(command.argumentHint || "").trim();
    suggestions.push({
      type: "command",
      value,
      label: argumentHint ? `${value} ${argumentHint}` : value,
      description: String(command.description || "").trim() || "Claude command",
      icon: "terminal",
      origin: getExternalSlashCommandOrigin(value),
    });
  }

  return suggestions;
}

export interface ParsedSlashCommand {
  command: SlashCommandDefinition;
  args: string[];
}

export function parseSlashCommandInput(message: string): ParsedSlashCommand | null {
  if (!message.startsWith("/")) {
    return null;
  }

  const parts = message.slice(1).trim().split(/\s+/).filter(Boolean);
  const name = parts[0]?.toLowerCase();
  if (!name) {
    return null;
  }

  const command = COMMAND_BY_NAME.get(name);
  if (!command) {
    return null;
  }

  return {
    command,
    args: parts.slice(1),
  };
}

export function getSlashCommandInputText(command: SlashCommandDefinition): string {
  return command.argumentHint ? `${command.command} ` : command.command;
}
