import { describe, it, expect, vi } from "vitest";

import { createMockApp } from "../../mocks/obsidian/App.mock";
import { click } from "../../helpers/dom";
import { PermissionModal } from "../../../src/views/PermissionModal";
import { DiffApprovalModal } from "../../../src/views/DiffApprovalModal";

describe("Permission and Diff modals", () => {
  it("should approve with selected remember choice in PermissionModal", () => {
    const app = createMockApp();
    const onApprove = vi.fn();
    const onDeny = vi.fn();

    const modal = new PermissionModal(
      app as any,
      {
        toolName: "Bash",
        toolInput: { command: "rm -rf /tmp/test" },
        description: "Run shell command",
        risk: "high",
      },
      onApprove,
      onDeny
    );

    modal.open();

    expect(modal.contentEl.textContent).toContain("Permission Required");
    expect(modal.contentEl.textContent).toContain("HIGH RISK");
    expect(modal.contentEl.textContent).toContain("Tool:");
    expect(modal.contentEl.textContent).toContain("Bash");

    const sessionRadio = modal.contentEl.querySelector(
      'input[name="remember"][value="session"]'
    ) as HTMLInputElement;
    sessionRadio.checked = true;
    sessionRadio.dispatchEvent(new Event("change", { bubbles: true }));

    const approveBtn = modal.contentEl.querySelector(".claude-code-permission-approve") as HTMLButtonElement;
    click(approveBtn);

    expect(onApprove).toHaveBeenCalledWith("session");
    expect(onDeny).not.toHaveBeenCalled();
    expect(modal.containerEl.isConnected).toBe(false);
  });

  it("should deny PermissionModal requests", () => {
    const app = createMockApp();
    const onApprove = vi.fn();
    const onDeny = vi.fn();

    const modal = new PermissionModal(
      app as any,
      {
        toolName: "Write",
        toolInput: { file_path: "note.md" },
        description: "Write file content",
        risk: "medium",
      },
      onApprove,
      onDeny
    );

    modal.open();
    const denyBtn = modal.contentEl.querySelector(".claude-code-permission-deny") as HTMLButtonElement;
    click(denyBtn);

    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("should approve with selected remember choice in DiffApprovalModal", () => {
    const app = createMockApp();
    const onApprove = vi.fn();
    const onDeny = vi.fn();

    const modal = new DiffApprovalModal(
      app as any,
      "--- note.md\n+++ note.md\n@@\n-old\n+new",
      "Apply edit to note.md",
      onApprove,
      onDeny
    );

    modal.open();
    expect(modal.contentEl.textContent).toContain("Review Proposed Edit");
    expect(modal.contentEl.textContent).toContain("Apply edit to note.md");

    const alwaysRadio = modal.contentEl.querySelector(
      'input[name="remember"][value="always"]'
    ) as HTMLInputElement;
    alwaysRadio.checked = true;
    alwaysRadio.dispatchEvent(new Event("change", { bubbles: true }));

    const applyBtn = modal.contentEl.querySelector(".claude-code-permission-approve") as HTMLButtonElement;
    click(applyBtn);

    expect(onApprove).toHaveBeenCalledWith("always");
    expect(onDeny).not.toHaveBeenCalled();
  });

  it("should deny DiffApprovalModal requests", () => {
    const app = createMockApp();
    const onApprove = vi.fn();
    const onDeny = vi.fn();

    const modal = new DiffApprovalModal(
      app as any,
      "--- old\n+++ new",
      "Reject diff",
      onApprove,
      onDeny
    );

    modal.open();
    const denyBtn = modal.contentEl.querySelector(".claude-code-permission-deny") as HTMLButtonElement;
    click(denyBtn);

    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
  });
});
