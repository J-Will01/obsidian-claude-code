export type HintSeverity = "info" | "warning";

export interface HintRuleInput {
  contextPercentUsed: number;
  usagePercentUsed: number | null;
  permissionPromptSignals: number;
  hasPendingMcpApproval: boolean;
  permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions";
}

export interface HintSuggestion {
  id: string;
  text: string;
  command: string;
  severity: HintSeverity;
  priority: number;
  cooldownMs: number;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function buildContextualHints(input: HintRuleInput): HintSuggestion[] {
  const hints: HintSuggestion[] = [];
  const contextPercent = clampPercent(input.contextPercentUsed);
  const usagePercent =
    input.usagePercentUsed === null ? null : clampPercent(input.usagePercentUsed);

  if (contextPercent >= 90) {
    hints.push({
      id: "context-critical",
      text: `Context is ${contextPercent.toFixed(0)}% full. Run /context, then trim with /clear-pins.`,
      command: "/context",
      severity: "warning",
      priority: 100,
      cooldownMs: 2 * 60 * 1000,
    });
  } else if (contextPercent >= 80) {
    hints.push({
      id: "context-high",
      text: `Context is ${contextPercent.toFixed(0)}% used. Review headroom with /context.`,
      command: "/context",
      severity: "info",
      priority: 90,
      cooldownMs: 3 * 60 * 1000,
    });
  }

  if (usagePercent !== null && usagePercent >= 90) {
    hints.push({
      id: "usage-critical",
      text: `5h usage is ${usagePercent.toFixed(0)}%. Check /usage and consider /model haiku.`,
      command: "/usage",
      severity: "warning",
      priority: 95,
      cooldownMs: 2 * 60 * 1000,
    });
  } else if (usagePercent !== null && usagePercent >= 75) {
    hints.push({
      id: "usage-high",
      text: `5h usage is ${usagePercent.toFixed(0)}%. Check /usage before your next run.`,
      command: "/usage",
      severity: "info",
      priority: 72,
      cooldownMs: 3 * 60 * 1000,
    });
  }

  if (input.permissionMode === "default" && input.permissionPromptSignals >= 2) {
    hints.push({
      id: "permissions-friction",
      text: "Permission prompts are repeating. Review /permissions to reduce friction.",
      command: "/permissions",
      severity: "warning",
      priority: 85,
      cooldownMs: 4 * 60 * 1000,
    });
  }

  if (input.hasPendingMcpApproval) {
    hints.push({
      id: "mcp-approval",
      text: "Some MCP servers need approval. Check /mcp.",
      command: "/mcp",
      severity: "info",
      priority: 70,
      cooldownMs: 5 * 60 * 1000,
    });
  }

  return hints.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.id.localeCompare(b.id);
  });
}
