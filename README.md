# GSD Hints Injector

`gsd-hints-injector` does exactly three orthogonal things:

1. **Inject HINTS into the stable system prompt.**
2. **Move known dynamic system prompt lines into a hidden user message.**
3. **Stabilize Responses payload identifiers that would otherwise change per conversation.**

Those concerns are deliberately separate. HINTS injection should not depend on provider payload shape. Dynamic context movement should not depend on Responses-specific IDs. Responses identifier stabilization should not decide what belongs in the prompt.

## Installation

```bash
gsd install git:github.com/PamelaSprin47685ghall/gsd-hints-injector
```

## HINTS Sources

1. Global hints: `~/.gsd/HINTS.md`, or `${GSD_HOME}/HINTS.md` when `GSD_HOME` is set.
2. Project hints: `.gsd/HINTS.md`, falling back to `HINTS.md` in the project root.

The extension merges global then project hints, removes duplicate identical content, caps the merged text to `GSD_HINTS_MAX_CHARS` (`4000` by default), and injects the result into `systemPrompt` inside stable markers:

```text
<!-- gsd-hints-injector:system-hints:start -->
...
<!-- gsd-hints-injector:system-hints:end -->
```

Existing marked HINTS blocks are replaced each turn, so edits to HINTS files take effect without accumulating duplicate prompt text.

## 1. HINTS Injection

This is a pure system prompt transform:

- remove any previous `gsd-hints-injector` HINTS block,
- append the current merged HINTS block,
- leave unrelated system prompt text alone.

The injected HINTS are stable prompt material and should remain in `systemPrompt` for every provider.

## 2. Dynamic System Prompt Movement

GSD currently appends these dynamic lines to the base system prompt:

```text
Current date and time: ...
Current working directory: ...
```

The extension removes those lines from `systemPrompt` and sends them as a hidden per-turn custom message:

```text
Prompt Dynamic Context

Current date and time: ...
Current working directory: ...
```

The custom message uses `customType: "prompt-dynamic-context"` and `display: false`. Pi converts it into an automated system notification in the LLM message history. The extension only moves dynamic lines that came from GSD's official system prompt; it never fabricates runtime date or working-directory values itself.

This movement is provider-independent. Non-Responses providers receive the hidden message through normal Pi message conversion. Responses providers receive the same hidden message first, then the provider-payload boundary normalizes it into a clean Responses input item.

## 3. Responses Payload Identifier Stabilization

OpenAI Responses-compatible providers have additional payload-level cache/identity concerns that ordinary chat-style providers do not have.

GSD's built-in Responses providers populate `prompt_cache_key` from the per-session UUID. That makes the first request in each new conversation use a different cache identifier even when the stable system prompt is identical. This extension replaces that volatile value with:

```text
gsd-hints-<hash>
```

The hash is derived from:

- provider,
- API family,
- model ID,
- stable prompt text extracted from `payload.instructions` or the first `system` / `developer` input item.

The rule is narrow: payload identifiers that affect prompt caching must be stable when the stable prompt is stable. This is separate from HINTS injection and separate from dynamic context movement.

## Provider Payload Boundary

`before_agent_start` handles the provider-agnostic work:

- inject stable HINTS into `systemPrompt`,
- strip dynamic date/cwd lines from `systemPrompt`,
- emit one hidden `prompt-dynamic-context` user message when dynamic lines were present.

`before_provider_request` handles Responses payload cleanup:

- shape `payload.instructions` or `payload.input` when prompt material reaches the provider boundary directly,
- remove stale `prompt-dynamic-context` carrier messages from `payload.input`,
- insert one fresh dynamic context item at the front of Responses `input`,
- stabilize `prompt_cache_key` from the stable prompt.

The host provider wrapper is only for Responses-compatible providers:

- `openai-responses`,
- `azure-openai-responses`,
- `openai-codex-responses`.

It composes the provider's existing `onPayload` callback so interactive paths that bypass the public event still get the same payload cleanup.

## What the ../gsd-2 Analysis Found

Relevant source paths in `../gsd-2`:

- `packages/pi-coding-agent/src/core/system-prompt.ts`
  - `buildSystemPrompt()` constructs the base `systemPrompt`.
  - Stable sections include role, tool list, guidelines, docs pointers, skills, and project context.
  - Dynamic tail lines include current date/time and current working directory.
- `packages/pi-coding-agent/src/core/agent-session.ts`
  - `prompt()` calls `emitBeforeAgentStart(expandedText, images, this._baseSystemPrompt)`, then sets the Agent system prompt.
  - `Agent._runLoop()` snapshots `state.systemPrompt` before the loop starts.
- `packages/pi-agent-core/src/agent-loop.ts`
  - `streamAssistantResponse()` converts session messages to provider messages and calls the provider stream function.
- `packages/pi-coding-agent/src/core/messages.ts`
  - hidden custom messages become automated user-role system notifications in LLM context.
- `packages/pi-ai/src/providers/openai-responses.ts`
  - OpenAI Responses uses `input` and `prompt_cache_key`.
- `packages/pi-ai/src/providers/openai-codex-responses.ts`
  - Codex Responses uses `instructions`, `input`, and `prompt_cache_key`.
- `packages/pi-ai/src/api-registry.ts`
  - `registerApiProvider()` stores wrapped stream closures, so extension-side idempotency must compare against the post-registration provider returned by `getApiProvider()`.

## Diagnostics

Lifecycle diagnostics are emitted as structured JSON through `ctx.ui.notify` when UI hooks are available.

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

## Cache Status UI

After each assistant response, the extension reads provider-reported `usage.cacheRead` and `usage.cacheWrite` from the completed assistant message and writes a compact footer status via `ctx.ui.setStatus`:

- `cache hit <pct>% R<tokens>` — upstream reported cached input tokens.
- `cache warm W<tokens>` — upstream reported cache creation/write tokens but no read yet.
- `cache no-read` — usage was present, but no cached input tokens were reported.
- `cache n/a` — the response did not include usage telemetry.

This is based on upstream usage telemetry, not local prompt hashes.

## Re-runnable Verification Steps

```bash
# 1) hints-injector regression contract
node --test index.test.mjs

# 2) syntax check with Node's TypeScript stripper
node --experimental-strip-types --check index.ts

# 3) runtime import smoke test
node --experimental-strip-types -e "import('./index.ts').then(() => console.log('import ok'))"

# 4) orthogonal prompt transforms and payload shaping markers
rg -n "injectHintsIntoSystemPrompt|prepareSystemPrompt|prompt-dynamic-context|stabilizeResponsesPayloadIdentifiers|prompt_cache_key" index.ts

# 5) Responses wrapper installation and payload cleanup
rg -n "installHostProviderPromptWrappers|registerApiProvider|provider_prompt_cache_key_rebalanced|provider_payload_prompt_rebalanced" index.ts
```

Pass criteria:

- Each command exits `0`.
- Step (4) shows the three separate concerns: HINTS injection, dynamic context movement, and payload identifier stabilization.
- Step (5) shows Responses wrapper installation and cache-key rebalancing.
