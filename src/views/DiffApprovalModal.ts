import { App, Modal, setIcon } from "obsidian";
import { PermissionChoice } from "./PermissionModal";

export class DiffApprovalModal extends Modal {
  private diffText: string;
  private description: string;
  private onApprove: (choice: PermissionChoice) => void;
  private onDeny: () => void;
  private selectedChoice: PermissionChoice = "once";

  constructor(
    app: App,
    diffText: string,
    description: string,
    onApprove: (choice: PermissionChoice) => void,
    onDeny: () => void
  ) {
    super(app);
    this.diffText = diffText;
    this.description = description;
    this.onApprove = onApprove;
    this.onDeny = onDeny;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("claude-code-diff-modal");

    const headerEl = contentEl.createDiv({ cls: "claude-code-diff-header" });
    const iconEl = headerEl.createSpan({ cls: "claude-code-diff-icon" });
    setIcon(iconEl, "diff");
    headerEl.createEl("h2", { text: "Review Proposed Edit" });

    const descEl = contentEl.createDiv({ cls: "claude-code-diff-desc" });
    descEl.setText(this.description);

    const diffWrapper = contentEl.createDiv({ cls: "claude-code-diff-body" });
    const diffPre = diffWrapper.createEl("pre", { cls: "claude-code-diff-pre" });
    diffPre.setText(this.diffText);

    const rememberEl = contentEl.createDiv({ cls: "claude-code-permission-remember" });

    const onceLabel = rememberEl.createEl("label", { cls: "claude-code-permission-option" });
    const onceRadio = onceLabel.createEl("input", { type: "radio", attr: { name: "remember", value: "once" } });
    onceRadio.checked = true;
    onceLabel.createSpan({ text: " Approve once" });
    onceRadio.addEventListener("change", () => { this.selectedChoice = "once"; });

    const sessionLabel = rememberEl.createEl("label", { cls: "claude-code-permission-option" });
    const sessionRadio = sessionLabel.createEl("input", { type: "radio", attr: { name: "remember", value: "session" } });
    sessionLabel.createSpan({ text: " Remember for this session" });
    sessionRadio.addEventListener("change", () => { this.selectedChoice = "session"; });

    const alwaysLabel = rememberEl.createEl("label", { cls: "claude-code-permission-option" });
    const alwaysRadio = alwaysLabel.createEl("input", { type: "radio", attr: { name: "remember", value: "always" } });
    alwaysLabel.createSpan({ text: " Always allow (saved to settings)" });
    alwaysRadio.addEventListener("change", () => { this.selectedChoice = "always"; });

    const buttonsEl = contentEl.createDiv({ cls: "claude-code-permission-buttons" });
    const denyBtn = buttonsEl.createEl("button", { cls: "claude-code-permission-deny" });
    denyBtn.setText("Deny");
    denyBtn.addEventListener("click", () => {
      this.onDeny();
      this.close();
    });

    const approveBtn = buttonsEl.createEl("button", { cls: "claude-code-permission-approve mod-cta" });
    approveBtn.setText("Apply");
    approveBtn.addEventListener("click", () => {
      this.onApprove(this.selectedChoice);
      this.close();
    });

    denyBtn.focus();
  }

  onClose() {
    this.contentEl.empty();
  }
}
