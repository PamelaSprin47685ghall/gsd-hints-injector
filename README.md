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
- **No `before_agent_start` systemPrompt rewrite** → avoids per-user-turn prompt mutation.

## 设计原则（Session-Boundary Injection）

1. **会话边界优先，不按用户轮次注入**
   - 仅在 `session_start` 与 `session_switch:new` 注入。
   - 不使用 `before_agent_start` 做每轮 system prompt 改写。

2. **兼容 auto mode 的“新单元=新会话”语义**
   - 每个新的 auto unit 会话都能获得一次提示注入。
   - 启动期 `session_start -> session_switch:new` 的紧邻重复会被抑制一次，避免双注入。

3. **可预测、可审计、可回放**
   - 注入判定走 `boundary + session + hash` 去重。
   - 所有关键分支都输出统一结构化诊断字段（`plugin/phase/retryType/attempt/reason` + `boundary/source/hash`）。

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

| Path | Visible Hint Behavior (`session_start` / `session_switch:new`) | SystemPrompt Behavior | Unified Diagnostic Keywords |
|---|---|---|---|
| completed | New session emits one visible hints message; immediate bootstrap duplicate switch is suppressed | No per-turn systemPrompt mutation | `plugin=gsd-hints-injector`, `phase=conversation_inject_sent|conversation_inject_skip`, `reason=bootstrap_duplicate_after_session_start` |
| blocked (Type3 loop) | No extra visible hint spam unless a real new session boundary occurs | No per-turn systemPrompt mutation | `phase=conversation_inject_sent|conversation_inject_skip`, shared keys `plugin/phase/retryType/attempt/reason` |
| manual-stop / cancelled | Stand-down itself does not force visible hint reinjection; non-new switches are skipped | No per-turn systemPrompt mutation | `phase=conversation_inject_skip`, `reason=session_switch_non_new|boundary_hash_duplicate` |
| provider / transient retries | Retry turns in same session should not duplicate visible boundary messages | No per-turn systemPrompt mutation | `phase=conversation_inject_sent|conversation_inject_skip`, shared keys `plugin/phase/retryType/attempt/reason` |

## Re-runnable Verification Steps (Hints + Lifecycle Contract)

```bash
# 1) hints-injector regression contract
node --test gsd-hints-injector/index.test.mjs

# 2) boundary + suppression markers
rg -n "session_start|session_switch|agent_start|bootstrap_duplicate_after_session_start|boundary_hash_duplicate|session_switch_non_new|conversation_inject_skip" gsd-hints-injector/index.ts

# 3) verify no per-turn systemPrompt injection
rg -n "before_agent_start|upsertSystemPromptHints|SYSTEM_HINTS_START|system_prompt_" gsd-hints-injector/index.ts && exit 1 || true

# 4) shared observability keys across recovery + hints
rg -n "plugin:\s*PLUGIN|phase,|retryType,|attempt,|reason," gsd-auto-continue/index.ts gsd-hints-injector/index.ts
```

Pass criteria:
- Each command exits `0`.
- Step (2) matches all boundary/suppression markers.
- Step (3) returns no matches (no per-turn systemPrompt injection path).
- Step (4) confirms the shared diagnostics envelope required by the S02 verification rule.
