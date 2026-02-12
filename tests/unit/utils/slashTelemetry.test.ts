import { describe, expect, it } from "vitest";
import type { SlashCommandEvent } from "../../../src/types";
import { getTopSlashCommands, summarizeSlashCommandEvents } from "../../../src/utils/slashTelemetry";

const NOW = 1_700_000_000_000;

function makeEvent(
  partial: Partial<SlashCommandEvent> & Pick<SlashCommandEvent, "commandId" | "command" | "telemetryKey">
): SlashCommandEvent {
  return {
    timestamp: partial.timestamp ?? NOW,
    commandId: partial.commandId,
    command: partial.command,
    telemetryKey: partial.telemetryKey,
    handler: partial.handler ?? "local",
    action: partial.action ?? "selected",
    source: partial.source ?? "typed",
    argsCount: partial.argsCount ?? 0,
  };
}

describe("slash telemetry utilities", () => {
  it("should summarize action totals within time window", () => {
    const events: SlashCommandEvent[] = [
      makeEvent({ commandId: "model", command: "/model", telemetryKey: "slash_model", action: "selected" }),
      makeEvent({ commandId: "model", command: "/model", telemetryKey: "slash_model", action: "executedLocal" }),
      makeEvent({ commandId: "search", command: "/search", telemetryKey: "slash_search", action: "submittedToClaude" }),
      makeEvent({
        commandId: "old",
        command: "/old",
        telemetryKey: "slash_old",
        action: "selected",
        timestamp: NOW - 26 * 60 * 60 * 1000,
      }),
    ];

    const summary = summarizeSlashCommandEvents(events, 24, NOW);
    expect(summary).toEqual({
      total: 3,
      selected: 1,
      executedLocal: 1,
      submittedToClaude: 1,
    });
  });

  it("should return top commands sorted by total desc then name", () => {
    const events: SlashCommandEvent[] = [
      makeEvent({ commandId: "model", command: "/model", telemetryKey: "slash_model", action: "selected" }),
      makeEvent({ commandId: "model", command: "/model", telemetryKey: "slash_model", action: "executedLocal" }),
      makeEvent({ commandId: "search", command: "/search", telemetryKey: "slash_search", action: "selected" }),
      makeEvent({ commandId: "search", command: "/search", telemetryKey: "slash_search", action: "submittedToClaude" }),
      makeEvent({ commandId: "clear", command: "/clear", telemetryKey: "slash_clear", action: "executedLocal" }),
    ];

    const top = getTopSlashCommands(events, 24, 2, NOW);
    expect(top).toHaveLength(2);
    expect(top[0].command).toBe("/model");
    expect(top[0].total).toBe(2);
    expect(top[1].command).toBe("/search");
    expect(top[1].total).toBe(2);
  });

  it("should enforce a minimum top-command limit of one", () => {
    const events: SlashCommandEvent[] = [
      makeEvent({ commandId: "model", command: "/model", telemetryKey: "slash_model" }),
      makeEvent({ commandId: "clear", command: "/clear", telemetryKey: "slash_clear" }),
    ];

    const top = getTopSlashCommands(events, 24, 0, NOW);
    expect(top).toHaveLength(1);
  });
});
