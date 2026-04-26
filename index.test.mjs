import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("registers lifecycle boundaries for prompt rebalancing", () => {
  assert.match(source, /pi\.on\("session_start"/);
  assert.match(source, /pi\.on\("session_switch"/);
  assert.match(source, /pi\.on\("agent_start"/);
  assert.match(source, /pi\.on\("before_agent_start"/);
  assert.match(source, /pi\.on\("session_compact"/);
});

test("marks dynamic prompt context pending again after compaction", () => {
  assert.match(source, /pi\.on\("session_compact"/);
  assert.match(source, /boundary: "session_compact"/);
  assert.match(source, /dynamic_context_pending_after_compact/);
  assert.match(source, /state\.pendingDynamicPromptContext = true/);
});

test("gates session_switch dynamic context to reason=new with bootstrap duplicate suppression", () => {
  assert.match(source, /if \(event\.reason !== "new"\)/);
  assert.match(source, /skipNextNewSwitchDynamicInjection/);
  assert.match(source, /agentStartedAfterSessionStart/);
  assert.match(source, /bootstrap_duplicate_after_session_start/);
});

test("implements hints dedupe and size cap controls", () => {
  assert.match(source, /const seenContentHashes = new Set<string>\(\)/);
  assert.match(source, /function capHintLength\(/);
  assert.match(source, /DEFAULT_MAX_HINTS_CHARS = 4000/);
  assert.match(source, /GSD_HINTS_MAX_CHARS/);
  assert.match(source, /Hints truncated:/);
});

test("moves stable HINTS into systemPrompt with explicit static markers", () => {
  assert.match(source, /SYSTEM_HINTS_START/);
  assert.match(source, /SYSTEM_HINTS_END/);
  assert.match(source, /STATIC_HINTS_SYSTEM_HEADER/);
  assert.match(source, /buildStaticHintsSystemSection/);
  assert.match(source, /static_hints_in_system_prompt/);
});

test("moves dynamic date and cwd lines out of systemPrompt into prompt context", () => {
  assert.match(source, /DYNAMIC_SYSTEM_PROMPT_LINE_PATTERNS/);
  assert.match(source, /Current date and time:/);
  assert.match(source, /Current working directory:/);
  assert.match(source, /splitSystemPromptForCache/);
  assert.match(source, /customType: "prompt-dynamic-context"/);
  assert.match(source, /moved_to_prompt_message/);
});

test("emits provider cache telemetry to footer status from assistant usage", () => {
  assert.match(source, /pi\.on\("message_end"/);
  assert.match(source, /buildCacheStatus/);
  assert.match(source, /usage\.cacheRead > 0/);
  assert.match(source, /cache hit/);
  assert.match(source, /usage\.cacheWrite > 0/);
  assert.match(source, /cache warm/);
  assert.match(source, /cache no-read/);
  assert.match(source, /uiSetStatus\(PLUGIN, status\)/);
  assert.match(source, /provider_cache_status/);
});

test("stabilizes OpenAI Responses prompt cache keys at provider payload boundary", () => {
  assert.match(source, /pi\.on\("before_provider_request"/);
  assert.match(source, /rebalanceProviderPromptCacheKey/);
  assert.match(source, /prompt_cache_key/);
  assert.match(source, /extractStablePromptFromPayload/);
  assert.match(source, /buildStablePromptCacheKey/);
  assert.match(source, /payload\.instructions/);
  assert.match(source, /first\.role !== "system" && first\.role !== "developer"/);
  assert.match(source, /provider_prompt_cache_key_rebalanced/);
});

test("wraps host OpenAI API providers for interactive AgentSession payloads", () => {
  assert.match(source, /resolveHostPiAiSpecifiers/);
  assert.match(source, /node_modules", "@gsd", "pi-ai", "dist", "index\.js"/);
  assert.match(source, /packages", "pi-ai", "dist", "index\.js"/);
  assert.match(source, /installHostProviderPromptCacheWrappers/);
  assert.match(source, /getApiProvider\(api\)/);
  assert.match(source, /registerApiProvider/);
  assert.match(source, /withPromptCachePayloadRebalancer/);
  assert.match(source, /openai-responses/);
  assert.match(source, /azure-openai-responses/);
  assert.match(source, /openai-codex-responses/);
  assert.match(source, /host_provider_prompt_cache_wrapper_installed/);
});

test("emits structured diagnostics with unified and prompt-split-specific fields", () => {
  assert.match(source, /plugin:\s*PLUGIN/);
  assert.match(source, /phase,/);
  assert.match(source, /retryType,/);
  assert.match(source, /attempt,/);
  assert.match(source, /reason,/);
  assert.match(source, /boundary,/);
  assert.match(source, /source,/);
  assert.match(source, /hash,/);
  assert.match(source, /system_prompt_rebalanced/);
  assert.match(source, /dynamic_prompt_context_sent/);
  assert.match(source, /provider_cache_status/);
});
