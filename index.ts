import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export default function hintsInjector(pi: any): void {
  pi.on("before_agent_start", (e: any) => buildBeforeAgentStartResult(e.systemPrompt));
  pi.on("before_provider_request", stabilizeResponsesPayload);
}

export function buildBeforeAgentStartResult(systemPrompt: string) {
  let cwd = "";
  const dynLines: string[] = [], keptLines: string[] = [];
  
  for (const line of systemPrompt.split("\n")) {
    if (/^Current (date|working directory)/.test(line)) {
      dynLines.push(line.trim());
      const m = line.match(/directory:\s+(.+)$/);
      if (m) cwd = m[1];
    } else {
      keptLines.push(line);
    }
  }

  const sources = loadHintSources(cwd);
  const hints = sources.length ? `[HINTS — Stable Guidance]\n\nThese instructions come from HINTS.md files and are intentionally injected into the stable system prompt.\n\n` + sources.map(s => `## ${s.label} HINTS (${s.path})\n\n${s.content}`).join("\n\n") : "";
  
  const nextSys = keptLines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  const finalSys = hints ? `${nextSys}\n\n${hints}` : nextSys;

  const msg = dynLines.length ? {
    customType: "gsd-hints-dynamic-context", display: false,
    content: `[SYSTEM CONTEXT — Dynamic Runtime]\n\nThese lines were moved out of the stable system prompt for prompt-cache stability. Treat them as current runtime context for this turn.\n\n${dynLines.join("\n")}`,
    details: { movedLineCount: dynLines.length }
  } : undefined;

  if (finalSys === systemPrompt && !msg) return undefined;
  return { ...(finalSys !== systemPrompt && { systemPrompt: finalSys }), ...(msg && { message: msg }) };
}

function read(p: string) {
  try { return existsSync(p) ? readFileSync(p, "utf8").trim() : ""; } catch { return ""; }
}

export function loadHintSources(cwd?: string) {
  const s: any[] = [];
  const gPath = join(process.env.GSD_HOME || join(homedir(), ".gsd"), "HINTS.md");
  const g = read(gPath);
  if (g) s.push({ label: "Global", path: gPath, content: g });
  
  if (cwd) {
    const p1 = join(cwd, ".gsd", "HINTS.md"), p2 = join(cwd, "HINTS.md");
    const c1 = read(p1), c2 = read(p2);
    if (c1) s.push({ label: "Project", path: p1, content: c1 });
    else if (c2) s.push({ label: "Project", path: p2, content: c2 });
  }
  return s;
}

export function stabilizeResponsesPayload(event: any) {
  const p = event.payload;
  if (!p || typeof p !== "object" || Array.isArray(p)) return undefined;
  if (!["openai-responses", "azure-openai-responses"].includes(event.model?.api || "") && !(Array.isArray(p.input) && ("prompt_cache_key" in p || "store" in p))) return undefined;

  let changed = false;
  const next = { ...p };

  const key = process.env.GSD_HINTS_PROMPT_CACHE_KEY?.trim() || (() => {
    if (!Array.isArray(next.input)) return undefined;
    const text = next.input.filter(i => i && typeof i === "object" && (i.role === "system" || i.role === "developer"))
      .map(i => typeof i.content === "string" ? i.content : Array.isArray(i.content) ? i.content.map((b: any) => b?.text || "").join("\n") : "")
      .filter(Boolean).join("\n\n");
    return text ? `gsd-hints:${createHash("sha256").update(text).digest("hex").slice(0, 24)}` : undefined;
  })();

  if (key && next.prompt_cache_key !== key) { next.prompt_cache_key = key; changed = true; }

  if (Array.isArray(next.input)) {
    const { input, changed: c } = stabilizeResponsesInput(next.input);
    if (c) { next.input = input; changed = true; }
  }
  return changed ? next : undefined;
}

export function stabilizeResponsesInput(input: any[]) {
  const callMap = new Map();
  let m = 0, f = 0, changed = false;
  
  const getCallId = (id: string) => {
    if (!callMap.has(id)) callMap.set(id, `call_${callMap.size}`);
    return callMap.get(id);
  };

  const next = input.map(i => {
    if (!i || typeof i !== "object") return i;
    let out = i;
    const upd = (k: string, v: any) => { if (out[k] !== v) { if (out === i) out = { ...i }; out[k] = v; changed = true; } };

    if (i.type === "message" && i.role === "assistant" && typeof i.id === "string") upd("id", `msg_${m++}`);
    if (i.type === "function_call") {
      if (typeof i.call_id === "string") upd("call_id", getCallId(i.call_id));
      if (typeof i.id === "string") upd("id", `fc_${f++}`);
    }
    if (i.type === "function_call_output" && typeof i.call_id === "string") upd("call_id", getCallId(i.call_id));
    return out;
  });
  return { input: next, changed };
}
