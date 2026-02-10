# Claude Code Parity Roadmap Progress

Started: 2026-02-10  
Branch: `codex/parity-roadmap-phase1`

## Phase 0 - Setup

- [x] Create feature branch for parity implementation.
- [x] Establish a validated baseline (`typecheck`, `lint`, `test`).
- [x] Create a persistent progress checklist document.

## Phase 1 - Core Parity Foundations

### Slash Command Parity

- [x] Wire local slash command callbacks from chat input into `ChatView`.
- [x] Make `/new` and `/clear` execute real local actions.
- [x] Add parity-oriented command scaffolds: `/status`, `/permissions`, `/mcp`.
- [x] Add `/rewind` UX flow backed by checkpoint restore.

### Permission / Safety Parity

- [x] Make `autoApproveVaultReads` actually control read-only tool auto-approval.
- [x] Keep session and persistent ("always allow") approvals compatible with read tools.
- [x] Add explicit SDK permission mode setting (`default`, `acceptEdits`, `plan`, `bypassPermissions`).
- [x] Tighten defaults to match safer native behavior.

## Phase 2 - Runtime Controls

- [x] Expose richer session status details in UI (`model`, turns, auth source, MCP status).
- [ ] Add checkpoint/rewind controls that map to Claude Code-native workflow.
- [x] Add richer MCP management UI beyond raw JSON editing.

## Phase 3 - Hardening and Test Depth

- [x] Update permission utility and property tests for the read-approval policy.
- [x] Re-run full test suite after phase 1 changes.
- [ ] Add component-level tests for real slash command execution flow.
- [ ] Expand end-to-end style tests for permission modal behavior.
