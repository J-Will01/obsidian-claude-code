import type { Vault } from "obsidian";
import * as path from "path";

export function createUnifiedDiff(filePath: string, oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const header = `--- ${filePath}\n+++ ${filePath}\n@@\n`;
  const removed = oldLines.map((line) => `-${line}`).join("\n");
  const added = newLines.map((line) => `+${line}`).join("\n");
  return `${header}${removed}\n${added}`.trimEnd();
}

export function applySimpleEdit(oldText: string, edit: { old_string: string; new_string: string; replace_all?: boolean }): string {
  if (edit.replace_all) {
    return oldText.split(edit.old_string).join(edit.new_string);
  }
  return oldText.replace(edit.old_string, edit.new_string);
}

export function applyMultiEdit(oldText: string, edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }>): string {
  return edits.reduce((current, edit) => applySimpleEdit(current, edit), oldText);
}

export async function createBackup(
  vault: Vault,
  conversationId: string,
  filePath: string,
  oldText: string
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = path.basename(filePath);
  const backupDir = `.obsidian-claude-code/backups/${conversationId}`;
  const backupPath = `${backupDir}/${timestamp}-${baseName}.bak`;

  if (!(await vault.adapter.exists(backupDir))) {
    await vault.adapter.mkdir(backupDir);
  }
  await vault.adapter.write(backupPath, oldText);
  return backupPath;
}

export async function revertFromBackup(vault: Vault, filePath: string, backupPath: string): Promise<void> {
  const backupContent = await vault.adapter.read(backupPath);
  await vault.adapter.write(filePath, backupContent);
}
