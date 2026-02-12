import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS } from "../../../src/utils/autocomplete";
import {
  getExternalSlashCommandOrigin,
  getExternalSlashCommandSuggestions,
  getSlashCommandByValue,
  getSlashCommandInputText,
  getSlashCommands,
  normalizeSlashCommandName,
  parseSlashCommandInput,
} from "../../../src/utils/slashCommands";

describe("slash command contracts", () => {
  it("should keep autocomplete entries aligned with parser commands", () => {
    const autocompleteValues = new Set(SLASH_COMMANDS.map((cmd) => cmd.value));
    const parserValues = new Set(getSlashCommands().map((cmd) => cmd.command));
    expect(autocompleteValues).toEqual(parserValues);
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.origin).toBe("local");
    }
  });

  it("should define required metadata for each command", () => {
    for (const command of getSlashCommands()) {
      expect(command.id.length).toBeGreaterThan(0);
      expect(command.command.startsWith("/")).toBe(true);
      expect(command.description.length).toBeGreaterThan(0);
      expect(command.icon.length).toBeGreaterThan(0);
      expect(command.telemetryKey.length).toBeGreaterThan(0);
      expect(command.handler === "local" || command.handler === "sendToClaude").toBe(true);
    }
  });

  it("should parse every known command", () => {
    for (const command of getSlashCommands()) {
      const parsed = parseSlashCommandInput(`${command.command} arg1 arg2`);
      expect(parsed).not.toBeNull();
      expect(parsed?.command.id).toBe(command.id);
      expect(parsed?.args).toEqual(["arg1", "arg2"]);
    }
  });

  it("should parse command names case-insensitively", () => {
    const parsed = parseSlashCommandInput("/MODEL opus");
    expect(parsed).not.toBeNull();
    expect(parsed?.command.id).toBe("model");
    expect(parsed?.args).toEqual(["opus"]);
  });

  it("should resolve lookup from autocomplete value", () => {
    for (const suggestion of SLASH_COMMANDS) {
      const command = getSlashCommandByValue(suggestion.value);
      expect(command).not.toBeNull();
      expect(command?.command).toBe(suggestion.value);
    }
  });

  it("should add trailing space only for commands with argument hints", () => {
    const withHint = getSlashCommandByValue("/file");
    const withoutHint = getSlashCommandByValue("/clear");
    expect(withHint).not.toBeNull();
    expect(withoutHint).not.toBeNull();
    expect(getSlashCommandInputText(withHint!)).toBe("/file ");
    expect(getSlashCommandInputText(withoutHint!)).toBe("/clear");
  });

  it("should define unique telemetry keys", () => {
    const keys = getSlashCommands().map((cmd) => cmd.telemetryKey);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it("should normalize external command names with slash prefix", () => {
    expect(normalizeSlashCommandName("model")).toBe("/model");
    expect(normalizeSlashCommandName("/model")).toBe("/model");
    expect(normalizeSlashCommandName("")).toBe("");
  });

  it("should convert external commands to autocomplete suggestions", () => {
    const suggestions = getExternalSlashCommandSuggestions([
      { name: "review", description: "Review code", argumentHint: "[path]" },
      { name: "/review", description: "Duplicate", argumentHint: "" },
    ]);
    expect(suggestions).toEqual([
      {
        type: "command",
        value: "/review",
        label: "/review [path]",
        description: "Review code",
        icon: "terminal",
        origin: "sdk",
      },
    ]);
  });

  it("should classify external command origins", () => {
    expect(getExternalSlashCommandOrigin("/project:lint")).toBe("project");
    expect(getExternalSlashCommandOrigin("/user:notes")).toBe("personal");
    expect(getExternalSlashCommandOrigin("/mcp")).toBe("mcp");
    expect(getExternalSlashCommandOrigin("/review")).toBe("sdk");
  });
});
