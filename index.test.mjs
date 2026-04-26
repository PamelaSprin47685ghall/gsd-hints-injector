import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import hintsInjector, {
  buildBeforeAgentStartResult,
  loadHintSources,
  stabilizeResponsesInput,
  stabilizeResponsesPayload,
} from "./index.ts";

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "gsd-hints-injector-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withEnv(key, value, fn) {
  const old = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  }
}

test("registers the required lifecycle hooks", () => {
  const handlers = new Map();
  hintsInjector({
    on(event, handler) {
      handlers.set(event, handler);
    },
  });

  assert.equal(typeof handlers.get("before_agent_start"), "function");
  assert.equal(typeof handlers.get("before_provider_request"), "function");
});

test("loads global hints and prefers .gsd/HINTS.md over root HINTS.md", () => {
  withTempDir((projectDir) => {
    withTempDir((gsdHome) => {
      mkdirSync(join(projectDir, ".gsd"), { recursive: true });
      writeFileSync(join(gsdHome, "HINTS.md"), "global rule\n");
      writeFileSync(join(projectDir, ".gsd", "HINTS.md"), "project gsd rule\n");
      writeFileSync(join(projectDir, "HINTS.md"), "root fallback should not load\n");

      withEnv("GSD_HOME", gsdHome, () => {
        const sources = loadHintSources(projectDir);
        assert.equal(sources.length, 2);
        assert.equal(sources[0].label, "Global");
        assert.equal(sources[0].content, "global rule");
        assert.equal(sources[1].label, "Project");
        assert.equal(sources[1].content, "project gsd rule");
      });
    });
  });
});

test("falls back to project-root HINTS.md when .gsd/HINTS.md is absent", () => {
  withTempDir((projectDir) => {
    withTempDir((gsdHome) => {
      writeFileSync(join(projectDir, "HINTS.md"), "root project rule\n");

      withEnv("GSD_HOME", gsdHome, () => {
        const sources = loadHintSources(projectDir);
        assert.equal(sources.length, 1);
        assert.equal(sources[0].label, "Project");
        assert.equal(sources[0].content, "root project rule");
      });
    });
  });
});

test("injects hints into the system prompt", () => {
  withTempDir((projectDir) => {
    withTempDir((gsdHome) => {
      mkdirSync(join(projectDir, ".gsd"), { recursive: true });
      writeFileSync(join(gsdHome, "HINTS.md"), "Prefer terse output.\n");
      writeFileSync(join(projectDir, ".gsd", "HINTS.md"), "Use project-local tools.\n");

      withEnv("GSD_HOME", gsdHome, () => {
        const result = buildBeforeAgentStartResult([
          "Base system prompt",
          `Current working directory: ${projectDir}`,
        ].join("\n"));
        assert.ok(result?.systemPrompt?.includes("[HINTS — Stable Guidance]"));
        assert.ok(result?.systemPrompt?.includes("Prefer terse output."));
        assert.ok(result?.systemPrompt?.includes("Use project-local tools."));
      });
    });
  });
});

test("moves dynamic date and cwd lines into a hidden custom message", () => {
  withTempDir((gsdHome) => {
    withEnv("GSD_HOME", gsdHome, () => {
      const prompt = [
        "Base system prompt",
        "Current date and time: Sunday, April 26, 2026 at 11:57:19 PM GMT+8",
        "Current working directory: /tmp/project",
      ].join("\n");

      const result = buildBeforeAgentStartResult(prompt);
      assert.ok(result);
      assert.equal(result.systemPrompt, "Base system prompt");
      assert.equal(result.message?.customType, "gsd-hints-dynamic-context");
      assert.equal(result.message?.display, false);
      assert.match(result.message?.content ?? "", /Current date and time:/);
      assert.match(result.message?.content ?? "", /Current working directory:/);
    });
  });
});

test("returns undefined when there are no hints and no dynamic lines", () => {
  withTempDir((projectDir) => {
    withTempDir((gsdHome) => {
      withEnv("GSD_HOME", gsdHome, () => {
        const result = buildBeforeAgentStartResult("Stable prompt");
        assert.equal(result, undefined);
      });
    });
  });
});

test("stabilizes OpenAI Responses cache key and replay identifiers", () => {
  withEnv("GSD_HINTS_PROMPT_CACHE_KEY", "project-cache-key", () => {
    const payload = {
      model: "gpt-5",
      input: [
        { role: "developer", content: "stable official system prompt" },
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "message", role: "assistant", id: "msg_random_a", content: [] },
        { type: "function_call", id: "fc_random", call_id: "call_random", name: "read", arguments: "{}" },
        { type: "function_call_output", call_id: "call_random", output: "ok" },
        { type: "message", role: "assistant", id: "msg_random_b", content: [] },
      ],
      prompt_cache_key: "session-specific-key",
      store: false,
    };

    const result = stabilizeResponsesPayload(
      { type: "before_provider_request", payload, model: { api: "openai-responses", provider: "openai", id: "gpt-5" } },
    );

    assert.notEqual(result, undefined);
    assert.equal(result.prompt_cache_key, "project-cache-key");
    assert.equal(result.input[2].id, "msg_0");
    assert.equal(result.input[3].id, "fc_0");
    assert.equal(result.input[3].call_id, "call_0");
    assert.equal(result.input[4].call_id, "call_0");
    assert.equal(result.input[5].id, "msg_1");

    assert.equal(payload.prompt_cache_key, "session-specific-key", "original payload should not be mutated");
    assert.equal(payload.input[3].call_id, "call_random", "original input should not be mutated");
  });
});

test("stabilizes response input arrays without touching unrelated items", () => {
  const { input, changed } = stabilizeResponsesInput([
    { type: "reasoning", id: "rs_provider_id", encrypted_content: "opaque" },
    { type: "function_call_output", call_id: "late_call", output: "ok" },
  ]);

  assert.equal(changed, true);
  assert.equal(input[0].id, "rs_provider_id");
  assert.equal(input[1].call_id, "call_0");
});

test("does not alter non-Responses provider payloads", () => {
  const payload = { messages: [{ role: "user", content: "hi" }] };
  const result = stabilizeResponsesPayload(
    { type: "before_provider_request", payload, model: { api: "anthropic-messages", provider: "anthropic", id: "claude" } },
  );

  assert.equal(result, undefined);
});
