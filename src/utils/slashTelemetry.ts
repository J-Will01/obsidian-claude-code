import type { SlashCommandEvent } from "../types";

export interface SlashCommandEventSummary {
  total: number;
  selected: number;
  executedLocal: number;
  submittedToClaude: number;
}

export interface TopSlashCommandStat extends SlashCommandEventSummary {
  commandId: string;
  command: string;
  telemetryKey: string;
}

function eventsInWindow(
  events: SlashCommandEvent[],
  windowHours: number,
  now: number
): SlashCommandEvent[] {
  const windowMs = Math.max(1, windowHours) * 60 * 60 * 1000;
  const cutoff = now - windowMs;
  return events.filter((event) => event.timestamp >= cutoff);
}

export function summarizeSlashCommandEvents(
  events: SlashCommandEvent[],
  windowHours = 24,
  now = Date.now()
): SlashCommandEventSummary {
  const filtered = eventsInWindow(events, windowHours, now);

  return filtered.reduce(
    (acc, event) => {
      acc.total += 1;
      if (event.action === "selected") acc.selected += 1;
      if (event.action === "executedLocal") acc.executedLocal += 1;
      if (event.action === "submittedToClaude") acc.submittedToClaude += 1;
      return acc;
    },
    {
      total: 0,
      selected: 0,
      executedLocal: 0,
      submittedToClaude: 0,
    }
  );
}

export function getTopSlashCommands(
  events: SlashCommandEvent[],
  windowHours = 24,
  limit = 5,
  now = Date.now()
): TopSlashCommandStat[] {
  const filtered = eventsInWindow(events, windowHours, now);
  const byCommand = new Map<string, TopSlashCommandStat>();

  for (const event of filtered) {
    const existing = byCommand.get(event.commandId) ?? {
      commandId: event.commandId,
      command: event.command,
      telemetryKey: event.telemetryKey,
      total: 0,
      selected: 0,
      executedLocal: 0,
      submittedToClaude: 0,
    };

    existing.total += 1;
    if (event.action === "selected") existing.selected += 1;
    if (event.action === "executedLocal") existing.executedLocal += 1;
    if (event.action === "submittedToClaude") existing.submittedToClaude += 1;
    byCommand.set(event.commandId, existing);
  }

  return Array.from(byCommand.values())
    .sort((a, b) => {
      if (a.total !== b.total) return b.total - a.total;
      return a.command.localeCompare(b.command);
    })
    .slice(0, Math.max(1, limit));
}
