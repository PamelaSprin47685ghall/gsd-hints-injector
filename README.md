# GSD Hints Injector

Injects `HINTS.md` (global + project) into GSD while keeping provider prompts cache-friendly.

The plugin keeps stable guidance in `systemPrompt`, removes known dynamic tail lines from that stable prompt, and injects those dynamic values at the safest available boundary:

- OpenAI Responses-compatible providers: the actual outbound provider payload.
- Other providers: a hidden per-turn custom message from `before_agent_start`.

This avoids relying on session-start/session-switch timing to decide whether a dynamic prompt message should be present.

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

## Prompt Rebalancing

### Static: kept in `systemPrompt`

- Pi/GSD role and tool instructions from GSD's base prompt.
- Large stable descriptions, guidelines, docs pointers, skill table, and project context already assembled by GSD.
- Global/project `HINTS.md`, wrapped in `gsd-hints-injector` markers.

### Dynamic: moved out of `systemPrompt`

- `Current date and time: ...`
- `Current working directory: ...`

These lines are stripped from `systemPrompt` deterministically on every turn. For Responses payloads, the dynamic context is inserted directly into the outbound `input` array immediately before the provider request is sent. Existing stale `prompt-dynamic-context` notification items are removed from that payload first, so the provider sees one fresh dynamic context item.

For non-Responses providers, the same dynamic context is sent as a hidden custom message with `customType: "prompt-dynamic-context"`. The extension only reuses dynamic context that came from GSD's official `systemPrompt`; it does not recreate session time or working-directory lines itself.

## What the ../gsd-2 analysis found

Relevant source paths in `../gsd-2`:

- `packages/pi-coding-agent/src/core/system-prompt.ts`
  - `buildSystemPrompt()` constructs the base `systemPrompt`.
  - Stable sections: assistant role, tool list, guidelines, Pi docs pointers, append section, project context files, skills.
  - Dynamic tail: `Current date and time: ...` and `Current working directory: ...` are appended at the end for both default and custom prompts.
- `packages/pi-coding-agent/src/core/agent-session.ts`
  - `prompt()` calls `emitBeforeAgentStart(expandedText, images, this._baseSystemPrompt)`, then sets the Agent system prompt.
  - `Agent._runLoop()` snapshots `state.systemPrompt` before the loop starts.
- `packages/pi-agent-core/src/agent-loop.ts`
  - `streamAssistantResponse()` builds the actual provider context and calls the provider stream function.
- `packages/pi-coding-agent/src/core/sdk.ts`
  - SDK/headless paths expose `before_provider_request` through the public extension event.
- `packages/pi-ai/src/api-registry.ts`
  - `registerApiProvider()` stores wrapped stream closures, so extension-side wrapper idempotency must compare against the post-registration provider returned by `getApiProvider()`.

## Stable Implementation

The plugin now uses a stateless model:

- `before_agent_start`
  - always strips dynamic date/cwd lines from the turn's system prompt,
  - always appends current HINTS into the marked static block,
  - emits a hidden dynamic context message only for non-Responses providers.
- `before_provider_request`
  - shapes the actual outbound payload for SDK/headless paths,
  - removes stale/current dynamic context notification carrier items,
  - inserts one fresh dynamic context item from the latest carrier, the outbound system prompt, or the official `before_agent_start` dynamic-context snapshot,
  - never fabricates date/cwd values itself, so session-start time remains owned by GSD's system prompt builder,
  - only mutates payloads that already contain GSD-managed prompt material, so internal summarization calls are not polluted,
  - derives `prompt_cache_key` from provider + API + model + stable prompt.
- Host provider wrapper
  - wraps `openai-responses`, `azure-openai-responses`, and `openai-codex-responses`,
  - composes the provider's `onPayload` callback for interactive paths that bypass the public event,
  - retries installation at `session_start`, `model_select`, `before_agent_start`, and `before_provider_request`,
  - records the post-registration provider from `getApiProvider()` to avoid double-wrapping.

The old `session_switch` / `session_compact` pending-state machinery was removed. Dynamic context is derived from the real prompt/payload each time instead of from lifecycle bookkeeping.

## Dedupe + Length Cap

- Source dedupe: if global and project hint content is identical (after normalization), duplicated content is dropped.
- Length cap: merged hints are capped to `GSD_HINTS_MAX_CHARS` (default `4000`) with truncation notice.
- Static marker replacement: prior `gsd-hints-injector` system HINTS blocks are removed before appending the latest static HINTS block.

## Cache Status UI

After each assistant response, the extension reads provider-reported `usage.cacheRead` and `usage.cacheWrite` from the completed assistant message and writes a compact footer status via `ctx.ui.setStatus`:

- `cache hit <pct>% R<tokens>` — upstream reported cached input tokens for this response.
- `cache warm W<tokens>` — upstream reported cache creation/write tokens but no read yet.
- `cache no-read` — upstream usage was present, but no cached input tokens were reported.
- `cache n/a` — the response did not include usage telemetry.

This is deliberately based on upstream usage telemetry, not local prompt hashes.

## Provider Cache Key Rebalancing

For OpenAI Responses-compatible payloads, the extension rewrites provider `prompt_cache_key` values before the upstream request is sent. GSD's built-in Responses providers populate that key from the per-session UUID, which prevents first-turn cache reads across separate conversations even when the stable system prompt is identical.

The replacement key is `gsd-hints-<hash>`, where the hash is derived from provider, API, model ID, and the stable system prompt extracted from `payload.instructions` or a `system`/`developer` item in `payload.input`.

Anthropic payloads use `cache_control` instead of `prompt_cache_key`, so they are left untouched.

## Diagnostics

Lifecycle diagnostics are emitted as structured JSON with unified fields:

- `plugin`, `phase`, `reason`
- plus prompt-shaping fields: `boundary`, `source`, `hash`

Important phases:

- `system_prompt_rebalanced`
- `dynamic_prompt_context_sent`
- `provider_payload_prompt_rebalanced`
- `provider_prompt_cache_key_rebalanced`
- `provider_cache_status`
- `host_provider_prompt_wrapper_installed`
- `host_provider_registry_unavailable`
- `host_provider_registry_skip`
- `hints_source_deduped`
- `hints_truncated`

## Re-runnable Verification Steps

```bash
# 1) hints-injector regression contract
node --test index.test.mjs

# 2) syntax check with Node's TypeScript stripper
node --experimental-strip-types --check index.ts

# 3) runtime import smoke test
node --experimental-strip-types -e "import('./index.ts').then(() => console.log('import ok'))"

# 4) prompt split and payload shaping markers
rg -n "before_agent_start|before_provider_request|shapeProviderPayload|SYSTEM_HINTS_START|prompt-dynamic-context|Current date and time|Current working directory" index.ts

# 5) provider request paths stabilize OpenAI Responses prompt cache keys
rg -n "installHostProviderPromptWrappers|registerApiProvider|prompt_cache_key|provider_prompt_cache_key_rebalanced|provider_payload_prompt_rebalanced" index.ts
```

Pass criteria:

- Each command exits `0`.
- Step (4) matches both turn-level and provider-payload prompt shaping.
- Step (5) matches provider wrapper installation and cache-key rebalancing.
