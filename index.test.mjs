import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("registers lifecycle boundaries for session_start/session_switch/agent_start", () => {
  assert.match(source, /pi\.on\("session_start"/);
  assert.match(source, /pi\.on\("session_switch"/);
  assert.match(source, /pi\.on\("agent_start"/);
});

test("gates session_switch injection to reason=new with bootstrap duplicate suppression", () => {
  assert.match(source, /if \(event\.reason !== "new"\)/);
  assert.match(source, /skipNextNewSwitchVisibleInjection/);
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

test("does not modify systemPrompt on every user turn", () => {
  assert.equal(source.includes('pi.on("before_agent_start"'), false);
  assert.equal(source.includes("upsertSystemPromptHints"), false);
  assert.equal(source.includes("SYSTEM_HINTS_START"), false);
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
