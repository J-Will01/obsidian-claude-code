# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Added
- Local `/doctor` slash command for session diagnostics and remediation guidance.
- Richer `/help` output with grouped command catalog, discovered command origins, keyboard guidance, and examples.
- Contextual input hint chips with deterministic rules (context pressure, usage pressure, permission friction, MCP approval prompts).
- `Shift+Tab` permission-mode cycling in chat input (`default` -> `acceptEdits` -> `plan` -> `default`).

### Changed
- Slash command autocomplete selection now fills the input first (including `Tab`) and requires submit to execute/send.
- Slash command UX/docs aligned around CLI-style composer flow and keyboard-first interactions.

### Fixed
- Streaming assistant transcript text is now merged across tool-call phases instead of being overwritten by later assistant segments.
- Final assistant message merge now preserves earlier content and tool-call context ordering during streaming completion.
- Chat transcript ordering now keeps tool-call cards in sequence with streamed text by splitting post-tool assistant text into a continuation message when needed.
- Rapid double-submit is now blocked at stream start to prevent duplicate user/assistant message runs.
- Eliminated shared-array aliasing between ChatView and ConversationManager display messages that could duplicate both user and assistant messages in the active transcript.

### Changed
- Removed per-message author headers (`You`/`Claude`) from chat bubbles while preserving left/right role layout.
