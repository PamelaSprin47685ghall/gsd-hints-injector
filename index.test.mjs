import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("registers lifecycle boundaries for session_start/session_switch/before_agent_start", () => {
  assert.match(source, /pi\.on\("session_start"/);
  assert.match(source, /pi\.on\("session_switch"/);
  assert.match(source, /pi\.on\("before_agent_start"/);
});

test("gates session_switch injection to reason=new with bootstrap duplicate suppression", () => {
  assert.match(source, /if \(event\.reason !== "new"\)/);
  assert.match(source, /skipNextNewSwitchVisibleInjection/);
  assert.match(source, /bootstrap_duplicate_after_session_start/);
});

test("implements hints dedupe and size cap controls", () => {
  assert.match(source, /const seenContentHashes = new Set<string>\(\)/);
  assert.match(source, /function capHintLength\(/);
  assert.match(source, /DEFAULT_MAX_HINTS_CHARS = 4000/);
  assert.match(source, /GSD_HINTS_MAX_CHARS/);
  assert.match(source, /Hints truncated:/);
});

test("uses idempotent systemPrompt upsert with append\/replace\/noop actions", () => {
  assert.match(source, /const SYSTEM_HINTS_BLOCK_RE = new RegExp/);
  assert.match(source, /function upsertSystemPromptHints\(/);
  assert.match(source, /action: "append" \| "replace" \| "noop"/);
  assert.match(source, /system_prompt_\$\{upsertResult\.action\}/);
});

test("emits structured diagnostics with unified and hints-specific fields", () => {
  assert.match(source, /plugin:\s*PLUGIN/);
  assert.match(source, /phase,/);
  assert.match(source, /retryType,/);
  assert.match(source, /attempt,/);
  assert.match(source, /reason,/);
  assert.match(source, /boundary,/);
  assert.match(source, /source,/);
  assert.match(source, /hash,/);
});
