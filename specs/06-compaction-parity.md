## Compaction parity (Codex CLI vs OpenCode)

---

### Codex CLI remote compaction trace (end-to-end)

Trigger
- Auto: `codex-rs/core/src/codex.rs` `run_turn` checks total usage tokens vs `auto_compact_token_limit` and calls `run_auto_compact`.
- Manual: `codex-rs/core/src/codex.rs` `handlers::compact` spawns `CompactTask` (`codex-rs/core/src/tasks/compact.rs`).
- Remote path is selected when provider is OpenAI and `Feature::RemoteCompaction` is enabled (`codex-rs/core/src/compact.rs`).

Compaction request (API payloads)
- `codex-rs/core/src/compact_remote.rs` clones history, builds a `Prompt` with:
  - `input: history.for_prompt()`
  - `tools: []`, `parallel_tool_calls: false`
  - `base_instructions_override` from the turn context
- `codex-rs/core/src/client.rs` builds and sends:
  - `CompactionInput { model, input, instructions }`
  - via `ApiCompactClient.compact_input` to `responses/compact` (`codex-rs/codex-api/src/endpoint/compact.rs`).
- Endpoint expects Responses wire API and returns JSON: `{ output: [ResponseItem, ...] }` (`codex-rs/codex-api/src/common.rs`, `codex-rs/codex-api/src/endpoint/compact.rs`).

History replacement and events
- `compact_remote.rs` appends any ghost snapshots, calls `sess.replace_history(new_history)`, recomputes token usage, and persists `RolloutItem::Compacted { replacement_history: Some(new_history) }`.
- Emits `EventMsg::ContextCompacted` so UI can show compaction completed.
- On resume/replay, `codex-rs/core/src/codex.rs` `reconstruct_history_from_rollout` uses `replacement_history` when present; otherwise it rebuilds using `compact::build_compacted_history` with `SUMMARY_PREFIX`.

Reference: remote compaction tests (request + history replacement)
- `codex-rs/core/tests/suite/compact.rs` asserts:
  - POST path `/v1/responses/compact`
  - compaction payload includes summarization prompt
  - subsequent turns include the compacted history and a compaction summary item

---

### OpenCode compaction flow (current)

Trigger
- Context overflow is detected in `packages/opencode/src/session/processor.ts` and schedules compaction.
- Token-based auto-compaction uses `SessionCompaction.isOverflow` with:
  - `compaction.auto_token_limit` or
  - `compaction.effective_context_percent` of model context (minus output budget)
  - tracked usage tokens from `Session.recordUsage`.

Compaction run
- `packages/opencode/src/session/compaction.ts` creates a compaction assistant message and runs a compaction prompt through the normal session processor.
- Plugins can override or extend the prompt via `experimental.session.compacting`.

History representation after compaction
- `packages/opencode/src/session/message-v2.ts` `filterCompacted` rebuilds history using:
  - the most recent user messages (up to 20k tokens)
  - a synthetic user message containing `[Compaction summary]` prefix plus summary text
- Summary prefix constant is defined in `packages/opencode/src/session/compaction-constants.ts`.

Configuration + UI
- Compaction config is documented in `packages/web/src/content/docs/config.mdx`.
- Session usage tokens are persisted (`packages/opencode/src/session/index.ts`) and used for the context indicator in the TUI header.

---

### Side-by-side flow diagram (trigger -> compaction -> history representation)

| Codex CLI (remote) | OpenCode (local summary) |
| --- | --- |
| Trigger: auto token threshold or `/compact` | Trigger: context overflow or token threshold |
| Compaction: build Prompt -> POST `/v1/responses/compact` with `{ model, input, instructions }` | Compaction: run compaction agent prompt -> assistant summary |
| History: replace with server `output` (ResponseItems); persist `replacement_history` | History: rebuild synthetic user messages (recent user text + `[Compaction summary]` + summary) |

---

### Improvement plan (derived from parity review)

1) Align trigger behavior
- Use token usage thresholds in addition to context overflow errors.
- Keep configurable limits to match Codex CLI auto-compaction tuning.

2) Make history representation deterministic
- Persist a stable summary prefix.
- Rebuild history from recent user messages plus summary, similar to Codex `build_compacted_history`.

3) Make compaction resilient
- Trim older messages and retry when compaction itself overflows.
- Record token usage for reliable threshold checks and UI feedback.

4) Add tests + docs
- Unit tests for overflow detection and history rebuild behavior.
- Document compaction config knobs.

---

### Tracked issue list (owners + acceptance criteria)

CMP-1: Add token-based compaction thresholds
- Owner: opencode-core
- Status: Done
- Acceptance criteria:
  - `SessionCompaction.isOverflow` uses `auto_token_limit` or `effective_context_percent`.
  - Unit tests cover both config paths and session usage fallback.

CMP-2: Rebuild compacted history with summary prefix
- Owner: opencode-core
- Status: Done
- Acceptance criteria:
  - History includes most recent user messages (20k tokens max).
  - Summary is stored as synthetic user text with `[Compaction summary]` prefix.
  - Unit test verifies summary prefix and rebuild order.

CMP-3: Handle context overflow during compaction
- Owner: opencode-core
- Status: Done
- Acceptance criteria:
  - Compaction retries after trimming oldest messages when overflow detected.
  - Compaction stops cleanly when only one message remains.

CMP-4: Track usage tokens for UI + overflow checks
- Owner: opencode-core
- Status: Done
- Acceptance criteria:
  - Session persists last known usage tokens.
  - TUI context indicator uses usage tokens when available.

CMP-5: Document compaction knobs
- Owner: opencode-docs
- Status: Done
- Acceptance criteria:
  - Config docs list `compaction.auto_token_limit` and `compaction.effective_context_percent`.

---

### Implementation plan (action order + acceptance tests)

Step 1: Token threshold + overflow detection
- Acceptance tests:
  - `bun test test/session/compaction.test.ts`

Step 2: History rebuild with summary prefix
- Acceptance tests:
  - `bun test test/session/message-v2.test.ts`

Step 3: Compaction retry on overflow
- Acceptance tests:
  - `bun test test/session/compaction.test.ts`

Step 4: Usage tracking + UI indicator
- Acceptance tests:
  - `bun test test/session/compaction.test.ts`

Step 5: Docs update
- Acceptance tests:
  - Docs build (if required by CI)
