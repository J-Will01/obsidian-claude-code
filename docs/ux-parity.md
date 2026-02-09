# UX Parity Notes

This document maps the current UX surface area to the planned Claude Code parity improvements, with file pointers for future edits.

## Streaming updates
- **Agent stream handling:** `src/agent/AgentController.ts` (handles SDK stream_event and emits partial updates).
- **Message updates in UI:** `src/views/ChatView.ts` (receives onMessage updates and updates/creates the streaming message).
- **Message rendering:** `src/views/MessageRenderer.ts` and `src/views/MessageList.ts` (renders markdown and incremental updates).

Current behavior:
- Partial text deltas flow through `handleStreamEvent()` and the StreamingAccumulator.
- ChatView updates the existing streaming message by ID and auto-scrolls only when user is near the bottom.

## Tool call display
- **Tool call parsing:** `src/agent/AgentController.ts` (processAssistantMessage, tool result normalization).
- **Tool call UI:** `src/views/ToolCallDisplay.ts` (expand/collapse, stdout/stderr, copy output, revert).
- **Tool call list:** `src/views/MessageRenderer.ts` (creates ToolCallDisplay instances).

Current behavior:
- Tool calls appear in the assistant message, with richer output (stdout/stderr/exit code) and controls.

## Write actions (diff/patch + revert)
- **Permission gating:** `src/agent/AgentController.ts` (`handlePermission()` shows diff modal).
- **Diff generation + backups:** `src/utils/DiffEngine.ts` (unified diff, backup storage, revert).
- **Diff approval modal:** `src/views/DiffApprovalModal.ts`.
- **Revert UI:** `src/views/ToolCallDisplay.ts` (revert button uses backups).

Current behavior:
- Write/Edit/MultiEdit requests can show a diff modal before applying.
- Backups are stored under `.obsidian-claude-code/backups/{conversationId}/`.
