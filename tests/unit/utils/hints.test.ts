import { describe, expect, it } from "vitest";
import { buildContextualHints } from "../../../src/utils/hints";

describe("buildContextualHints", () => {
  it("should return no hints when thresholds are not met", () => {
    const hints = buildContextualHints({
      contextPercentUsed: 42,
      usagePercentUsed: 35,
      permissionPromptSignals: 0,
      hasPendingMcpApproval: false,
      permissionMode: "default",
    });

    expect(hints).toEqual([]);
  });

  it("should prioritize critical context and usage hints", () => {
    const hints = buildContextualHints({
      contextPercentUsed: 94,
      usagePercentUsed: 93,
      permissionPromptSignals: 0,
      hasPendingMcpApproval: false,
      permissionMode: "default",
    });

    expect(hints.map((hint) => hint.id)).toEqual([
      "context-critical",
      "usage-critical",
    ]);
    expect(hints[0].priority).toBeGreaterThan(hints[1].priority);
  });

  it("should include permission friction hint only in default mode", () => {
    const defaultModeHints = buildContextualHints({
      contextPercentUsed: 10,
      usagePercentUsed: 10,
      permissionPromptSignals: 3,
      hasPendingMcpApproval: false,
      permissionMode: "default",
    });
    expect(defaultModeHints.some((hint) => hint.id === "permissions-friction")).toBe(true);

    const bypassHints = buildContextualHints({
      contextPercentUsed: 10,
      usagePercentUsed: 10,
      permissionPromptSignals: 3,
      hasPendingMcpApproval: false,
      permissionMode: "bypassPermissions",
    });
    expect(bypassHints.some((hint) => hint.id === "permissions-friction")).toBe(false);
  });

  it("should include MCP approval hint when servers need approval", () => {
    const hints = buildContextualHints({
      contextPercentUsed: 10,
      usagePercentUsed: null,
      permissionPromptSignals: 0,
      hasPendingMcpApproval: true,
      permissionMode: "default",
    });

    expect(hints).toEqual([
      expect.objectContaining({
        id: "mcp-approval",
        command: "/mcp",
      }),
    ]);
  });
});
