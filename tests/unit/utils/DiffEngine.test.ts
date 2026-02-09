import { describe, it, expect } from "vitest";
import { createUnifiedDiff, createBackup, revertFromBackup } from "@/utils/DiffEngine";
import { createMockVault } from "../../mocks/obsidian/Vault.mock";

describe("DiffEngine", () => {
  it("creates a unified diff", () => {
    const diff = createUnifiedDiff("note.md", "old line", "new line");
    expect(diff).toContain("--- note.md");
    expect(diff).toContain("+new line");
  });

  it("creates and reverts backups", async () => {
    const vault = createMockVault();
    await vault.adapter.write("note.md", "original");

    const backupPath = await createBackup(vault as any, "conv-1", "note.md", "original");
    await vault.adapter.write("note.md", "changed");
    await revertFromBackup(vault as any, "note.md", backupPath);

    const reverted = await vault.adapter.read("note.md");
    expect(reverted).toBe("original");
  });
});
