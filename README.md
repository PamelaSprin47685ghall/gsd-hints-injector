# GSD Hints Injector

Injects `HINTS.md` (global + project) into GSD with **boundary-aware**, **deduplicated**, and **size-capped** behavior.

## Installation

```bash
gsd install git:github.com/PamelaSprin47685ghall/gsd-hints-injector
```

## Usage

1. **Global hints:** create `~/.gsd/HINTS.md` (or `${GSD_HOME}/HINTS.md` if `GSD_HOME` is set).
2. **Project hints:** create `.gsd/HINTS.md` or `HINTS.md` in project root.

Priority remains:

1. Global (`~/.gsd/HINTS.md`)
2. Project (`.gsd/HINTS.md`, fallback to `HINTS.md`)

## Injection Boundaries

- `session_start` → sends one visible hints message for session boot.
- `session_switch` (`reason === "new"`) → sends one visible hints message for new auto-mode unit sessions.
  - If a `session_switch:new` immediately follows `session_start` before any agent turn, it is treated as bootstrap duplicate and suppressed once.
- `before_agent_start` → upserts hints into `systemPrompt` as a strong constraint (append/replace/noop), preventing repeated duplicate blocks.

## Dedupe + Length Cap

- Source dedupe: if global and project hint content is identical (after normalization), duplicated content is dropped.
- Boundary dedupe: repeated visible injections with the same `boundary + session + hash` are suppressed.
- Length cap: merged hints are capped to `GSD_HINTS_MAX_CHARS` (default `4000`) with truncation notice.

## Diagnostics

Lifecycle diagnostics are emitted as structured JSON with unified fields:

- `plugin`, `phase`, `retryType`, `attempt`, `reason`
- plus hints-specific `boundary`, `source`, `hash`

This makes hint injection decisions replayable and auditable across session lifecycle transitions.

## S02 Failure-Path Matrix (Hints Perspective)

Pair this with `gsd-auto-continue/README.md`'s lifecycle matrix when running S03 integration.

| Path | Visible Hint Behavior (`session_start` / `session_switch:new`) | `before_agent_start` Behavior | Unified Diagnostic Keywords |
|---|---|---|---|
| completed | New session emits one visible hints message; immediate bootstrap duplicate switch is suppressed | First turn appends block, later turns noop/replace by hash | `plugin=gsd-hints-injector`, `phase=conversation_inject_sent|conversation_inject_skip`, `reason=bootstrap_duplicate_after_session_start` |
| blocked (Type3 loop) | No extra visible hint spam unless a real new session boundary occurs | Type3 remediation turns keep one logical hint block via idempotent upsert | `phase=system_prompt_append|system_prompt_replace|system_prompt_noop`, `reason=hints_block_upserted|hints_block_already_current` |
| manual-stop / cancelled | Stand-down itself does not force visible hint reinjection; non-new switches are skipped | Upsert resumes only when a subsequent agent turn actually starts | `phase=conversation_inject_skip`, `reason=session_switch_non_new|boundary_hash_duplicate` |
| provider / transient retries | Retry turns in same session should not duplicate visible boundary messages | Prompt block remains single-copy across retries (append once, then noop/replace as needed) | `phase=system_prompt_append|system_prompt_noop|system_prompt_replace`, shared keys `plugin/phase/retryType/attempt/reason` |

## Re-runnable Verification Steps (Hints + Lifecycle Contract)

```bash
# 1) hints-injector regression contract
node --test gsd-hints-injector/index.test.mjs

# 2) boundary + suppression markers
rg -n "session_start|session_switch|before_agent_start|bootstrap_duplicate_after_session_start|boundary_hash_duplicate|session_switch_non_new|conversation_inject_skip" gsd-hints-injector/index.ts

# 3) systemPrompt idempotent upsert markers
rg -n "upsertSystemPromptHints|SYSTEM_HINTS_BLOCK_RE|system_prompt_(append|replace|noop)" gsd-hints-injector/index.ts

# 4) shared observability keys across recovery + hints
rg -n "plugin:\s*PLUGIN|phase,|retryType,|attempt,|reason," gsd-auto-continue/index.ts gsd-hints-injector/index.ts
```

Pass criteria:
- Each command exits `0`.
- Step (2) and step (3) match all suppression/upsert markers.
- Step (4) confirms the shared diagnostics envelope required by the S02 verification rule.
