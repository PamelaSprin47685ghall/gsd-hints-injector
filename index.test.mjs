import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("registers lifecycle boundaries for prompt rebalancing", () => {
  assert.match(source, /pi\.on\("session_start"/);
  assert.match(source, /pi\.on\("session_switch"/);
  assert.match(source, /pi\.on\("agent_start"/);
  assert.match(source, /pi\.on\("before_agent_start"/);
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
});
