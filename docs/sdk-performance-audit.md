# Obsidian SDK Performance Audit

## Scope
This audit focuses on SDK-facing and orchestration-heavy paths that affect latency, UI responsiveness, and repeated I/O.

Primary files reviewed:
- `src/agent/AgentController.ts`
- `src/agent/ConversationManager.ts`
- `src/views/ChatView.ts`
- `src/agent/ObsidianMcpServer.ts`

## Executive Summary

### Biggest shortfalls
1. **Agent orchestration is concentrated in one very large controller** (~1,055 LOC), combining transport, permission policy, diff generation, subagent tracking, and capability discovery. This increases branch complexity and makes hot-path optimization harder.
2. **Permission checks and edit-preview work perform repeated expensive operations** (`JSON.stringify(input)` keys, repeated array `includes`, and repeated diff+backup work) during every tool approval path.
3. **Conversation persistence is write-heavy and synchronous per event**, with `addMessage` and `updateUsage` always writing full JSON documents to disk.
4. **UI hinting scans full message history repeatedly**, including regex over message/tool output content, which grows linearly with conversation size.
5. **MCP tools often build/return large payloads eagerly**, including full file reads and broad command listings, which can increase token/serialization overhead.

### High-impact simplification opportunities
- Extract permission policy into a dedicated strategy module with precomputed `Set`s and a single decision pipeline.
- Add a debounced persistence layer in `ConversationManager` (append log or batched index/history writes).
- Replace repeated message-history scans for permission signals with incremental counters.
- Split `AgentController` into composable services (stream processor, tool lifecycle tracker, permission gateway, capability cache).

---

## Findings

### 1) Monolithic `AgentController` raises complexity on hot paths
**Evidence**
- `AgentController` is 1,055 lines and handles SDK query setup, retries, streaming updates, permission flows, diff approvals, subagent mapping, capability caching, and session lifecycle in one class.
- The main `sendMessageInternal` loop processes many message types and performs UI/event mutation inline.

**Why it hurts performance**
- Large mixed-responsibility methods increase branching and object churn in high-frequency stream handling.
- Hard to optimize specific paths (e.g., permission latency vs stream throughput) without side effects.

**Recommended simplification**
- Split into components:
  - `SdkQueryRunner` (query setup + retries)
  - `ToolPermissionGateway` (policy + approval UX)
  - `ToolLifecycleTracker` (tool/subagent state)
  - `CapabilityCache` (supported models/commands)
- Keep `AgentController` as a thin coordinator.

---

### 2) Permission path performs repeated work and dynamic allocations
**Evidence**
- Read-only, UI-safe, and write tool lists are created on each permission check.
- Write flows call diff-generation/backup code in multiple branches.
- Pending edit keys use `JSON.stringify(input)` for map keys.

**Why it hurts performance**
- Permission checks run frequently; recreating arrays and serializing large tool input repeatedly adds avoidable overhead.
- Duplicate diff-generation calls can do redundant file reads and diff computation.

**Recommended simplification**
- Hoist tool classification to module-level `Set`s.
- Introduce a single `evaluateWritePermission()` path that computes diff/backup once and reuses result.
- Replace serialized whole-input map keys with stable compact identifiers (e.g., `{tool}:{file}:{hash(old,new)}` when needed).

---

### 3) Conversation storage does eager full-file writes
**Evidence**
- `addMessage`, `updateUsage`, `setHistory`, `setPinnedContext`, and related methods save full conversation JSON immediately.
- Index updates are also saved immediately after per-conversation updates.

**Why it hurts performance**
- Frequent synchronous adapter writes during streaming/activity can block and increase perceived latency.
- Rewriting full conversation objects scales poorly as message history grows.

**Recommended simplification**
- Debounce writes (e.g., 250–500ms) and coalesce index + conversation persistence.
- Consider append-only journal for message events with periodic compaction.
- Use lightweight dirty flags to avoid unchanged-index writes.

---

### 4) UI contextual hint scoring rescans chat history
**Evidence**
- `getPermissionPromptSignals()` iterates `this.messages` and each message’s tool calls, applying regex checks each time hints refresh.
- `updateContextualInputHints()` invokes this at each telemetry/hint update path.

**Why it hurts performance**
- Work grows with conversation size and repeats even when no relevant new messages arrived.
- Regex over tool outputs/errors can be costly for long outputs.

**Recommended simplification**
- Maintain rolling counters keyed by time bucket when messages/tool results are appended.
- Recompute only delta for new messages rather than full scans.

---

### 5) MCP tool implementations return broad payloads by default
**Evidence**
- `get_active_file` reads full file then slices preview.
- `list_commands` can enumerate all commands before filter/limit output.
- `get_recent_files` sorts all markdown files each call.

**Why it hurts performance**
- Larger payload construction increases CPU and serialization overhead before tokenization.
- Some tools could be incremental or cached.

**Recommended simplification**
- Add optional lightweight modes (`metadataOnly`, `previewChars`, smaller defaults).
- Cache command index and invalidation hooks instead of full re-enumeration.
- For recent files, maintain a capped cache keyed by mtime updates if available.

---

## Prioritized Plan

### Phase 1 (quick wins, low risk)
1. Hoist tool categories to `Set`s and avoid per-call allocations in permission checks.
2. Deduplicate write diff/backup computation into one branch.
3. Add debounced save queue for conversation/index writes.
4. Introduce incremental permission-signal counter in `ChatView`.

### Phase 2 (medium risk, high ROI)
1. Extract `ToolPermissionGateway` from `AgentController`.
2. Extract `ToolLifecycleTracker` and simplify stream loop dispatch.
3. Add caches for MCP `list_commands` and recent files.

### Phase 3 (structural)
1. Move to append-only conversation event log + compaction.
2. Introduce a performance budget dashboard (stream update time, save latency, tool permission latency).

## Suggested Metrics to Track
- Mean/95p time from stream event receipt to UI update.
- Mean/95p permission decision latency (no-modal vs modal).
- Conversation save duration and writes per minute.
- Hint recomputation time and frequency.
- MCP tool invocation duration and payload size.

## Notes
- This audit intentionally emphasizes simplification and streamlining over adding new capabilities.
- Most wins can be achieved without changing external behavior by reducing repeated work and tightening hot-path boundaries.

## Implementation Progress Notes

### Completed in code (so far)
- Hoisted permission tool classification sets and reduced repeated allocations in permission checks.
- Consolidated write permission diff/backup computation path.
- Added no-op write skipping in conversation/index persistence.
- Added cached permission-signal scoring in `ChatView`.
- Reduced pending edit key serialization cost by using targeted hashed signatures instead of full `JSON.stringify(input)`.
- Added MCP `list_commands` short-TTL cache and lightweight options for `get_active_file` (`metadataOnly`, `previewChars`).
- Switched `buildMcpServers()` approval checks to a precomputed `Set` and added short-TTL caching for sorted markdown files in `get_recent_files`.

### Additional observations noticed while implementing
- `ChatView` still performs broad message/tool traversal in a few other helper paths; permission signals are cached now, but other analytics-like scans may benefit from incremental counters.
- `ConversationManager` currently optimizes no-op writes but still persists full JSON blobs for changed conversations; append-log + periodic compaction remains the highest-impact structural follow-up.
