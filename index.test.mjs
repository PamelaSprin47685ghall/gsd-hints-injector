import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import hintsInjector, { buildBeforeAgentStartResult, loadHintSources, stabilizeResponsesInput, stabilizeResponsesPayload, fixConsecutiveUserMessages } from "./index.js";

const withTmp = (fn) => {
  const d = mkdtempSync(join(tmpdir(), "gsd-"));
  try { return fn(d); } finally { rmSync(d, { recursive: true, force: true }); }
};

const withEnv = (k, v, fn) => {
  const o = process.env[k];
  v === undefined ? delete process.env[k] : process.env[k] = v;
  try { return fn(); } finally { o === undefined ? delete process.env[k] : process.env[k] = o; }
};

test("registers lifecycle hooks", () => {
  const h = new Map();
  hintsInjector({ on: (e, cb) => h.set(e, cb) });
  assert.equal(typeof h.get("before_agent_start"), "function");
  assert.equal(typeof h.get("context"), "function");
  assert.equal(typeof h.get("before_provider_request"), "function");
});

test("loads global hints and prefers .gsd/HINTS.md", () => withTmp(pDir => withTmp(gDir => {
  mkdirSync(join(pDir, ".gsd"));
  writeFileSync(join(gDir, "HINTS.md"), "global\n");
  writeFileSync(join(pDir, ".gsd", "HINTS.md"), "project\n");
  writeFileSync(join(pDir, "HINTS.md"), "root\n");
  withEnv("GSD_HOME", gDir, () => {
    const s = loadHintSources(pDir);
    assert.equal(s.length, 2);
    assert.equal(s[0].content, "global");
    assert.equal(s[1].content, "project");
  });
})));

test("falls back to root HINTS.md", () => withTmp(pDir => withTmp(gDir => {
  writeFileSync(join(pDir, "HINTS.md"), "root");
  withEnv("GSD_HOME", gDir, () => {
    const s = loadHintSources(pDir);
    assert.equal(s.length, 1);
    assert.equal(s[0].content, "root");
  });
})));

test("injects hints into system prompt", () => withTmp(pDir => withTmp(gDir => {
  mkdirSync(join(pDir, ".gsd"));
  writeFileSync(join(gDir, "HINTS.md"), "t1");
  writeFileSync(join(pDir, ".gsd", "HINTS.md"), "t2");
  withEnv("GSD_HOME", gDir, () => {
    const r = buildBeforeAgentStartResult(`Base\nCurrent working directory: ${pDir}`);
    assert.ok(r?.systemPrompt?.includes("[HINTS — Stable Guidance]"));
    assert.ok(r?.systemPrompt?.includes("t1"));
    assert.ok(r?.systemPrompt?.includes("t2"));
  });
})));

test("moves dynamic lines to custom message", () => withTmp(gDir => withEnv("GSD_HOME", gDir, () => {
  const r = buildBeforeAgentStartResult("Base\nCurrent date and time: Sun\nCurrent working directory: /tmp");
  assert.equal(r.systemPrompt, "Base");
  assert.equal(r.message?.customType, "gsd-hints-dynamic-context");
  assert.match(r.message.content, /Current date/);
})));

test("returns undefined if no hints and no dyn lines", () => withTmp(gDir => withEnv("GSD_HOME", gDir, () => {
  assert.equal(buildBeforeAgentStartResult("Stable prompt"), undefined);
})));

test("stabilizes cache key and identifiers", () => withEnv("GSD_HINTS_PROMPT_CACHE_KEY", "key", () => {
  const p = {
    model: "gpt-5",
    input: [
      { role: "developer", content: "sys" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { type: "message", role: "assistant", id: "msg_rnd", content: [] },
      { type: "function_call", id: "fc_rnd", call_id: "call_rnd" },
      { type: "function_call_output", call_id: "call_rnd", output: "ok" },
      { type: "message", role: "assistant", id: "msg_rnd2", content: [] }
    ],
    prompt_cache_key: "old", store: false
  };
  const r = stabilizeResponsesPayload({ type: "before_provider_request", payload: p, model: { api: "openai-responses", provider: "openai" } });
  assert.equal(r.prompt_cache_key, "key");
  assert.equal(r.input[2].id, "msg_0");
  assert.equal(r.input[3].id, "fc_0");
  assert.equal(r.input[3].call_id, "call_0");
  assert.equal(r.input[4].call_id, "call_0");
  assert.equal(r.input[5].id, "msg_1");
  assert.equal(p.prompt_cache_key, "old");
}));

test("stabilizes response input arrays safely", () => {
  const { input, changed } = stabilizeResponsesInput([
    { type: "reasoning", id: "rs_id" },
    { type: "function_call_output", call_id: "late" }
  ]);
  assert.ok(changed);
  assert.equal(input[0].id, "rs_id");
  assert.equal(input[1].call_id, "call_0");
});

test("ignores non-Responses provider payloads", () => {
  const r = stabilizeResponsesPayload({ payload: { messages: [] }, model: { api: "anthropic-messages" } });
  assert.equal(r, undefined);
});

test("fixConsecutiveUserMessages inserts 收到 between user and custom", () => {
  const msgs = [
    { role: "system", content: "be helpful" },
    { role: "user", content: "hello" },
    { role: "custom", customType: "gsd-hints-dynamic-context", content: "cwd: /tmp" },
  ];
  const r = fixConsecutiveUserMessages(msgs);
  assert.ok(r);
  assert.equal(r[1].role, "user");
  assert.equal(r[2].role, "assistant");
  assert.equal(r[2].content, "收到");
  assert.equal(r[3].role, "custom");
});

test("fixConsecutiveUserMessages inserts 收到 between custom and user", () => {
  const msgs = [
    { role: "system", content: "be helpful" },
    { role: "custom", customType: "gsd-hints-dynamic-context", content: "cwd: /tmp" },
    { role: "user", content: "hello" },
  ];
  const r = fixConsecutiveUserMessages(msgs);
  assert.ok(r);
  assert.equal(r[1].role, "custom");
  assert.equal(r[2].role, "assistant");
  assert.equal(r[2].content, "收到");
  assert.equal(r[3].role, "user");
});

test("fixConsecutiveUserMessages does nothing on alternating roles", () => {
  const msgs = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "again" },
  ];
  assert.equal(fixConsecutiveUserMessages(msgs), undefined);
});

test("fixConsecutiveUserMessages returns undefined on empty or single message", () => {
  assert.equal(fixConsecutiveUserMessages([]), undefined);
  assert.equal(fixConsecutiveUserMessages([{ role: "user", content: "hi" }]), undefined);
});