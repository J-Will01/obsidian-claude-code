import { describe, it, expect } from "vitest";
import fc from "fast-check";

// Permission handling rules from AgentController.handlePermission().
const readOnlyTools = [
  "Read",
  "Glob",
  "Grep",
  "LS",
  "mcp__obsidian__get_active_file",
  "mcp__obsidian__get_vault_stats",
  "mcp__obsidian__get_recent_files",
  "mcp__obsidian__list_commands",
];

const obsidianUiTools = [
  "mcp__obsidian__open_file",
  "mcp__obsidian__show_notice",
  "mcp__obsidian__reveal_in_explorer",
  "mcp__obsidian__execute_command",
  "mcp__obsidian__create_note",
];

const writeTools = ["Write", "Edit", "MultiEdit"];

// Simulate permission decision logic.
function shouldAutoApprove(
  toolName: string,
  settings: {
    autoApproveVaultReads: boolean;
    autoApproveVaultWrites: boolean;
    requireBashApproval: boolean;
    alwaysAllowedTools: string[];
  },
  sessionApprovedTools: Set<string>
): { autoApprove: boolean; reason: string } {
  // Check always-allowed list first.
  if (settings.alwaysAllowedTools.includes(toolName)) {
    return { autoApprove: true, reason: "always-allowed" };
  }

  // Read-only tools follow read auto-approval settings.
  if (readOnlyTools.includes(toolName)) {
    if (settings.autoApproveVaultReads) {
      return { autoApprove: true, reason: "auto-approve-reads" };
    }
    if (sessionApprovedTools.has(toolName)) {
      return { autoApprove: true, reason: "session-approved" };
    }
    return { autoApprove: false, reason: "requires-read-approval" };
  }

  // Obsidian UI tools are safe.
  if (obsidianUiTools.includes(toolName)) {
    return { autoApprove: true, reason: "obsidian-ui" };
  }

  // Write tools check settings.
  if (writeTools.includes(toolName)) {
    if (settings.autoApproveVaultWrites) {
      return { autoApprove: true, reason: "auto-approve-writes" };
    }
    if (sessionApprovedTools.has(toolName)) {
      return { autoApprove: true, reason: "session-approved" };
    }
    return { autoApprove: false, reason: "requires-write-approval" };
  }

  // Bash tool check settings.
  if (toolName === "Bash") {
    if (!settings.requireBashApproval) {
      return { autoApprove: true, reason: "bash-approval-disabled" };
    }
    if (sessionApprovedTools.has("Bash")) {
      return { autoApprove: true, reason: "session-approved" };
    }
    return { autoApprove: false, reason: "requires-bash-approval" };
  }

  // Task tool is auto-approved (subagents handle own permissions).
  if (toolName === "Task") {
    return { autoApprove: true, reason: "subagent" };
  }

  // Default: allow other tools.
  return { autoApprove: true, reason: "default" };
}

describe("permission handling property tests", () => {
  describe("read-only tools", () => {
    it("should respect autoApproveVaultReads for read-only tools", () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...readOnlyTools),
          fc.boolean(),
          fc.boolean(),
          fc.boolean(),
          fc.array(fc.string()),
          (toolName, autoApproveReads, autoApproveWrites, requireBash, alwaysAllowed) => {
            const settings = {
              autoApproveVaultReads: autoApproveReads,
              autoApproveVaultWrites: autoApproveWrites,
              requireBashApproval: requireBash,
              alwaysAllowedTools: alwaysAllowed,
            };
            const result = shouldAutoApprove(toolName, settings, new Set());
            const expected = autoApproveReads || alwaysAllowed.includes(toolName);
            expect(result.autoApprove).toBe(expected);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("should respect session approvals for read-only tools", () => {
      fc.assert(
        fc.property(fc.constantFrom(...readOnlyTools), (toolName) => {
          const settings = {
            autoApproveVaultReads: false,
            autoApproveVaultWrites: false,
            requireBashApproval: true,
            alwaysAllowedTools: [],
          };
          const sessionApproved = new Set<string>([toolName]);
          const result = shouldAutoApprove(toolName, settings, sessionApproved);

          expect(result.autoApprove).toBe(true);
          expect(result.reason).toBe("session-approved");
        }),
        { numRuns: 30 }
      );
    });
  });

  describe("obsidian UI tools", () => {
    it("should always auto-approve Obsidian UI tools regardless of settings", () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...obsidianUiTools),
          fc.boolean(),
          fc.boolean(),
          fc.boolean(),
          fc.array(fc.string()),
          (toolName, autoApproveReads, autoApproveWrites, requireBash, alwaysAllowed) => {
            const settings = {
              autoApproveVaultReads: autoApproveReads,
              autoApproveVaultWrites: autoApproveWrites,
              requireBashApproval: requireBash,
              alwaysAllowedTools: alwaysAllowed,
            };
            const result = shouldAutoApprove(toolName, settings, new Set());
            expect(result.autoApprove).toBe(true);
            expect(result.reason).toBe("obsidian-ui");
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("write tools", () => {
    it("should respect autoApproveVaultWrites setting", () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...writeTools),
          fc.boolean(),
          fc.boolean(),
          (toolName, autoApproveReads, autoApproveWrites) => {
            const settings = {
              autoApproveVaultReads: autoApproveReads,
              autoApproveVaultWrites: autoApproveWrites,
              requireBashApproval: true,
              alwaysAllowedTools: [],
            };
            const result = shouldAutoApprove(toolName, settings, new Set());

            if (autoApproveWrites) {
              expect(result.autoApprove).toBe(true);
              expect(result.reason).toBe("auto-approve-writes");
            } else {
              expect(result.autoApprove).toBe(false);
              expect(result.reason).toBe("requires-write-approval");
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it("should respect session approvals for write tools", () => {
      fc.assert(
        fc.property(fc.constantFrom(...writeTools), (toolName) => {
          const settings = {
            autoApproveVaultReads: false,
            autoApproveVaultWrites: false,
            requireBashApproval: true,
            alwaysAllowedTools: [],
          };
          const sessionApproved = new Set<string>([toolName]);
          const result = shouldAutoApprove(toolName, settings, sessionApproved);

          expect(result.autoApprove).toBe(true);
          expect(result.reason).toBe("session-approved");
        }),
        { numRuns: 30 }
      );
    });
  });

  describe("bash tool", () => {
    it("should respect requireBashApproval setting", () => {
      fc.assert(
        fc.property(fc.boolean(), (requireBashApproval) => {
          const settings = {
            autoApproveVaultReads: false,
            autoApproveVaultWrites: false,
            requireBashApproval,
            alwaysAllowedTools: [],
          };
          const result = shouldAutoApprove("Bash", settings, new Set());

          if (requireBashApproval) {
            expect(result.autoApprove).toBe(false);
            expect(result.reason).toBe("requires-bash-approval");
          } else {
            expect(result.autoApprove).toBe(true);
            expect(result.reason).toBe("bash-approval-disabled");
          }
        }),
        { numRuns: 20 }
      );
    });

    it("should respect session approvals for Bash", () => {
      const settings = {
        autoApproveVaultReads: false,
        autoApproveVaultWrites: false,
        requireBashApproval: true,
        alwaysAllowedTools: [],
      };
      const sessionApproved = new Set<string>(["Bash"]);
      const result = shouldAutoApprove("Bash", settings, sessionApproved);

      expect(result.autoApprove).toBe(true);
      expect(result.reason).toBe("session-approved");
    });
  });

  describe("always-allowed tools", () => {
    it("should respect alwaysAllowedTools for any tool", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }),
          (toolName) => {
            // Skip if it's a predefined tool type.
            if (
              readOnlyTools.includes(toolName) ||
              obsidianUiTools.includes(toolName)
            ) {
              return;
            }

            const settings = {
              autoApproveVaultReads: false,
              autoApproveVaultWrites: false,
              requireBashApproval: true,
              alwaysAllowedTools: [toolName],
            };
            const result = shouldAutoApprove(toolName, settings, new Set());

            expect(result.autoApprove).toBe(true);
            expect(result.reason).toBe("always-allowed");
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("Task tool (subagents)", () => {
    it("should always auto-approve Task tool regardless of settings", () => {
      fc.assert(
        fc.property(
          fc.boolean(),
          fc.boolean(),
          fc.boolean(),
          fc.array(fc.string()),
          (autoApproveReads, autoApproveWrites, requireBash, alwaysAllowed) => {
            const settings = {
              autoApproveVaultReads: autoApproveReads,
              autoApproveVaultWrites: autoApproveWrites,
              requireBashApproval: requireBash,
              alwaysAllowedTools: alwaysAllowed,
            };
            const result = shouldAutoApprove("Task", settings, new Set());

            expect(result.autoApprove).toBe(true);
            expect(result.reason).toBe("subagent");
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe("priority of rules", () => {
    it("should check always-allowed before write tools settings", () => {
      const settings = {
        autoApproveVaultReads: false,
        autoApproveVaultWrites: false,
        requireBashApproval: true,
        alwaysAllowedTools: ["Write"],
      };
      const result = shouldAutoApprove("Write", settings, new Set());

      expect(result.autoApprove).toBe(true);
      expect(result.reason).toBe("always-allowed");
    });

    it("should check always-allowed before Bash settings", () => {
      const settings = {
        autoApproveVaultReads: false,
        autoApproveVaultWrites: false,
        requireBashApproval: true,
        alwaysAllowedTools: ["Bash"],
      };
      const result = shouldAutoApprove("Bash", settings, new Set());

      expect(result.autoApprove).toBe(true);
      expect(result.reason).toBe("always-allowed");
    });
  });

  describe("determinism", () => {
    it("should produce consistent results for same inputs", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 30 }),
          fc.boolean(),
          fc.boolean(),
          fc.boolean(),
          fc.array(fc.string({ maxLength: 20 }), { maxLength: 5 }),
          fc.array(fc.string({ maxLength: 20 }), { maxLength: 5 }),
          (toolName, autoApproveReads, autoApprove, requireBash, alwaysAllowed, sessionApproved) => {
            const settings = {
              autoApproveVaultReads: autoApproveReads,
              autoApproveVaultWrites: autoApprove,
              requireBashApproval: requireBash,
              alwaysAllowedTools: alwaysAllowed,
            };
            const sessionSet = new Set(sessionApproved);

            const result1 = shouldAutoApprove(toolName, settings, sessionSet);
            const result2 = shouldAutoApprove(toolName, settings, sessionSet);

            expect(result1.autoApprove).toBe(result2.autoApprove);
            expect(result1.reason).toBe(result2.reason);
          }
        ),
        { numRuns: 200 }
      );
    });
  });
});
