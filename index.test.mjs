import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("uses stateless before_agent_start prompt shaping instead of session-boundary pending flags", () => {
  assert.match(source, /pi\.on\("before_agent_start"/);
  assert.doesNotMatch(source, /pendingDynamicPromptContext/);
  assert.doesNotMatch(source, /skipNextNewSwitchDynamicInjection/);
  assert.doesNotMatch(source, /agentStartedAfterSessionStart/);
  assert.doesNotMatch(source, /pi\.on\("session_switch"/);
  assert.doesNotMatch(source, /pi\.on\("agent_start"/);
  assert.doesNotMatch(source, /pi\.on\("session_compact"/);
});

test("keeps HINTS injection as its own systemPrompt transform", () => {
  assert.match(source, /SYSTEM_HINTS_START/);
  assert.match(source, /SYSTEM_HINTS_END/);
  assert.match(source, /STATIC_HINTS_SYSTEM_HEADER/);
  assert.match(source, /buildStaticHintsSystemSection/);
  assert.match(source, /function injectHintsIntoSystemPrompt/);
  assert.match(source, /static_hints_in_system_prompt/);
});

test("moves dynamic systemPrompt lines into a hidden user message independently of API family", () => {
  assert.match(source, /DYNAMIC_SYSTEM_PROMPT_LINE_PATTERNS/);
  assert.match(source, /Current date and time:/);
  assert.match(source, /Current working directory:/);
  assert.match(source, /splitSystemPromptForCache/);
  assert.match(source, /function prepareSystemPrompt/);
  assert.match(source, /customType: "prompt-dynamic-context"/);
  assert.match(source, /system_prompt_dynamic_context_as_user_message/);
  assert.doesNotMatch(source, /!isResponsesApi\(ctx\.model\)/);
  assert.doesNotMatch(source, /function isResponsesApi/);
});

test("normalizes Responses payload dynamic context at the provider boundary", () => {
  assert.match(source, /function shapeProviderPayload/);
  assert.match(source, /before_provider_request/);
  assert.match(source, /buildResponsesDynamicContextItem/);
  assert.match(source, /extractDynamicPromptContextFromItem/);
  assert.match(source, /containsManagedSystemPrompt/);
  assert.match(source, /actual_outbound_payload_shaped/);
});

test("stabilizes Responses payload identifiers from the stable prompt", () => {
  assert.match(source, /prompt_cache_key/);
  assert.match(source, /extractStablePromptFromPayload/);
  assert.match(source, /buildStablePayloadCacheKey/);
  assert.match(source, /stabilizeResponsesPayloadIdentifiers/);
  assert.match(source, /provider_prompt_cache_key_rebalanced/);
  assert.match(source, /stable_payload_identifier/);
});

test("never fabricates runtime prompt dynamic context", () => {
  assert.doesNotMatch(source, /function buildRuntimeDynamicContext/);
  assert.doesNotMatch(source, /new Date\(\)/);
  assert.doesNotMatch(source, /toLocaleString\("en-US"/);
});

test("wraps host Responses providers idempotently after upstream registry wrapping", () => {
  assert.match(source, /installHostProviderPromptWrappers/);
  assert.match(source, /getApiProvider\(api\)/);
  assert.match(source, /registerApiProvider/);
  assert.match(source, /openai-responses/);
  assert.match(source, /azure-openai-responses/);
  assert.match(source, /openai-codex-responses/);
  assert.match(source, /const registeredProvider = hostPiAi\.getApiProvider\(api\)/);
  assert.match(source, /__gsdHintsProviderWrappers\.set\(api, registeredProvider\)/);
  assert.match(source, /host_provider_prompt_wrapper_installed/);
});

test("resolves host pi-ai from the runtime resolver instead of argv-derived paths", () => {
  assert.match(source, /import\.meta\.resolve\("@gsd\/pi-ai"\)/);
  assert.match(source, /push\("@gsd\/pi-ai"\)/);
  assert.doesNotMatch(source, /process\.argv/);
  assert.doesNotMatch(source, /dirname\(entrypoint\)/);
  assert.doesNotMatch(source, /packages", "pi-ai", "dist", "index\.js"/);
});

test("retries wrapper installation at stable lifecycle points", () => {
  assert.match(source, /pi\.on\("session_start"/);
  assert.match(source, /pi\.on\("model_select"/);
  assert.match(source, /pi\.on\("before_provider_request"/);
  assert.match(source, /pi\.on\("before_agent_start"/);
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

test("implements hints dedupe and size cap controls", () => {
  assert.match(source, /const seenContentHashes = new Set<string>\(\)/);
  assert.match(source, /function capHintLength\(/);
  assert.match(source, /DEFAULT_MAX_HINTS_CHARS = 4000/);
  assert.match(source, /GSD_HINTS_MAX_CHARS/);
  assert.match(source, /Hints truncated:/);
});
