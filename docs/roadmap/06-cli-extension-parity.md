# Claude Code CLI/Extension Parity Audit

**Snapshot date:** February 11, 2026

This document compares the current Obsidian plugin UX against Claude Code CLI and Claude Code IDE extension capabilities, then proposes a pragmatic roadmap for what to build next.

## External Baseline (Claude Code Today)

Based on current official docs:

- Claude Code CLI has a broad built-in slash-command surface (`/clear`, `/compact`, `/cost`, `/doctor`, `/help`, `/mcp`, `/memory`, `/model`, `/permissions`, `/review`, `/status`, and more).
- Claude Code supports custom slash commands via Markdown files in `.claude/commands` (project or personal), including namespacing, argument hints, and command-scoped tool permissions.
- IDE extensions support all built-in and custom slash commands, plus contextual references like open files/tabs/diagnostics/current selection/current terminal command.
- IDE extension has intentional limitations compared to CLI (for example, no MCP server config from the extension UI, no memory editing from extension UI, no `!` shortcut, no tab completion parity).

References:
- https://docs.anthropic.com/en/docs/claude-code/interactive-mode
- https://docs.anthropic.com/en/docs/claude-code/slash-commands
- https://docs.anthropic.com/en/docs/claude-code/ide-integrations
- https://docs.anthropic.com/en/docs/claude-code/hooks
- https://docs.anthropic.com/en/docs/claude-code/settings

## Current Plugin State

What is already strong:

- Streaming, tool-call rendering, diff review, rewind/checkpoint, permission gating.
- Useful local slash commands for Obsidian workflows (`/file`, `/pin-file`, `/pin-selection`, `/pin-backlinks`, `/context`, `/usage`, `/mcp`, etc.).
- `@` file mention autocomplete and pinned-context controls.

Key implementation files:

- Slash command definitions: `src/utils/autocomplete.ts`
- Slash command parse/dispatch: `src/views/ChatInput.ts`, `src/views/ChatView.ts`
- Session/tool state: `src/agent/AgentController.ts`
- Control-panel diagnostics/actions: `src/views/components/ProjectControls.ts`

## Gap Matrix

| Area | Current | Claude Code baseline | Gap | Priority |
|---|---|---|---|---|
| Slash command source of truth | Static arrays + duplicated handling | Dynamic command metadata + rich command docs | Drift risk, inconsistent behavior | P0 |
| Typed vs selected command behavior | Not fully consistent (`/help` and `/search` differ between typed and autocomplete flows) | Consistent command semantics | UX surprise and trust erosion | P0 |
| Command metadata richness | Label + description only | Description + argument hints + command scope/context | Missing guidance at input time | P0 |
| Command discovery | Prefix autocomplete only | Command menu + complete slash catalog | Slower discoverability for non-power users | P1 |
| SDK-driven command/model discovery | Not wired | `supportedCommands()` / `supportedModels()` style dynamic discovery | Static command/model UX can stale | P1 |
| Context-aware coaching | Mostly manual (`/status`, `/usage`, `/context`) | Strong contextual cues and command affordances | User has to know what to ask | P1 |
| IDE parity cues | No command palette equivalent, no explicit "selection context on/off" affordance | Extension-level contextual entry points | More friction in day-to-day flow | P2 |
| Session diagnostics command depth | Good but compact | `/doctor`-style directed diagnostics flows | Debugging still manual | P2 |

## Recommended Roadmap

### Phase 1 (P0): Slash Command Foundation Cleanup

Goal: make slash commands deterministic and easy to extend.

1. Create one command registry type and source of truth.
   - Include: id, label, description, `argumentHint`, handler type (`local` vs `sendToClaude`), and telemetry key.
   - Use registry for both autocomplete and execution dispatch.
2. Unify typed and selected behavior.
   - If autocomplete selecting `/help` mutates input, typed `/help` should do the same.
   - Resolve `/search` semantics explicitly (local helper command or direct Claude pass-through, but not both).
3. Add command contract tests.
   - Ensure every displayed slash command has deterministic runtime behavior.
   - Ensure zero mismatch between autocomplete list and parser.

Implementation targets:

- `src/utils/autocomplete.ts`
- `src/views/ChatInput.ts`
- `src/views/ChatView.ts`
- `tests/integration/views/ChatInput.test.ts`
- `tests/unit/utils/autocomplete.test.ts`

### Phase 2 (P1): Dynamic Command/Model Parity

Goal: reduce static drift and improve discoverability.

1. Pull command/model metadata from SDK when session initializes.
   - Populate dynamic command list and argument hints in autocomplete UI.
2. Add command origin badges.
   - `Local`, `Claude built-in`, `Project custom`, `MCP`.
3. Upgrade `/help`.
   - Render a structured command catalog in-chat with examples.

Implementation targets:

- `src/agent/AgentController.ts` (session/init metadata capture)
- `src/types.ts` (command metadata model)
- `src/views/AutocompletePopup.ts` (origin badges + argument hint rendering)
- `src/views/ChatView.ts` (enhanced `/help` output)

### Phase 3 (P1): Contextual Tooltips and Timely Guidance

Goal: surface the right prompt at the right moment.

1. Add a lightweight hint engine with deterministic rules.
   - Context > 80%: suggest compaction/context cleanup.
   - Repeated permission prompts: suggest permission mode review.
   - MCP disabled/unapproved: suggest `/mcp`.
   - Rising 5-hour usage: suggest `/usage` and model downgrade.
2. Add non-blocking hint surfaces.
   - Input helper row (small text chips).
   - Header warning badges.
   - Optional dismissible notices.
3. Rate-limit hints.
   - Prevent repeated noise in a session.

Implementation targets:

- New: `src/utils/hints.ts`
- `src/views/ChatView.ts`
- `src/views/ChatInput.ts`
- `src/views/components/ProjectControls.ts`

### Phase 4 (P2): Extension-Style Interaction Upgrades (Obsidian-appropriate)

Goal: improve day-to-day speed without copying terminal-only concepts.

1. Add a command menu button near the input.
   - Quick access for slash commands, model, context actions.
2. Add explicit "selection context" affordance.
   - Show whether editor selection is currently pinned/included.
3. Add a `/doctor`-style diagnostics flow.
   - Verify auth, Claude executable, MCP health, permissions, and recent failures with remediation suggestions.

Implementation targets:

- `src/views/ChatInput.ts`
- `src/views/ChatView.ts`
- `src/settings/SettingsTab.ts`

## What Not To Mirror 1:1

These are CLI-first patterns and should not drive roadmap priority in Obsidian:

- Vim mode in chat input.
- Terminal `!` shortcut behavior.
- Terminal tab completion semantics.

For this plugin, prioritize editor-aware context and Obsidian workflow speed over shell parity.

## Proposed Execution Order (Next 6-8 Weeks)

1. Phase 1 immediately (slash command foundation, deterministic behavior).
2. Phase 2 next (dynamic command/model metadata, richer `/help`).
3. Phase 3 in parallel where low-risk (hint engine scaffold + one or two high-value rules).
4. Phase 4 after command/hint reliability is proven.

Success criteria:

- Slash command mismatch incidents reduced to zero in tests.
- Higher local-command usage (telemetry) and lower "unknown command" submissions.
- Lower permission friction (fewer repeated approvals per session).
- Faster time-to-first-success for new users (first conversation quality).
