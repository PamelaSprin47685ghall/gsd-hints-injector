import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

const PLUGIN = "gsd-hints-injector";
const DEFAULT_MAX_HINTS_CHARS = 4000;
const MAX_TRACKED_BOUNDARY_KEYS = 32;

const VISIBLE_HINTS_HEADER =
  "**System Auto-Injected HINTS:**\n\nPlease adhere to the following hints for this session:\n\n";

const SYSTEM_HINTS_START = "[USER-DEFINED HINTS — CRITICAL: ADHERE TO THESE RULES]";
const SYSTEM_HINTS_END = "[/USER-DEFINED HINTS]";
const SYSTEM_HINTS_BLOCK_RE = new RegExp(
  `${escapeRegExp(SYSTEM_HINTS_START)}[\\s\\S]*?${escapeRegExp(SYSTEM_HINTS_END)}`,
  "m",
);

type HintSource = "global" | "project";
type LifecycleBoundary = "session_start" | "session_switch:new" | "before_agent_start";

interface HintSegment {
  source: HintSource;
  label: string;
  content: string;
  hash: string;
}

interface ResolvedHints {
  text: string;
  hash: string;
  source: string;
  rawLength: number;
  finalLength: number;
  truncated: boolean;
  dedupedSources: HintSource[];
}

interface RuntimeState {
  skipNextNewSwitchVisibleInjection: boolean;
  beforeAgentSeenAfterSessionStart: boolean;
  seenConversationKeys: string[];
  seenConversationKeySet: Set<string>;
  lastConversationKey?: string;
}

interface PromptUpsertResult {
  systemPrompt: string;
  action: "append" | "replace" | "noop";
}

const state: RuntimeState = {
  skipNextNewSwitchVisibleInjection: false,
  beforeAgentSeenAfterSessionStart: false,
  seenConversationKeys: [],
  seenConversationKeySet: new Set<string>(),
  lastConversationKey: undefined,
};

const MAX_HINTS_CHARS = resolveMaxHintsChars();

function resolveMaxHintsChars(): number {
  const raw = Number(process.env.GSD_HINTS_MAX_CHARS ?? "");
  if (Number.isFinite(raw) && raw >= 500) {
    return Math.floor(raw);
  }
  return DEFAULT_MAX_HINTS_CHARS;
}

function truncate(text: string, max = 320): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function hashText(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

function normalizeContent(input: string): string {
  return input.replace(/\r\n?/g, "\n").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function boundaryId(boundary: LifecycleBoundary, event: unknown): string {
  const record = (event || {}) as Record<string, unknown>;
  const sessionRef =
    getStringField(record, "sessionId") ||
    getStringField(record, "sessionFile") ||
    getStringField(record, "newSessionId") ||
    getStringField(record, "nextSessionId") ||
    getStringField(record, "toSessionId") ||
    getStringField(record, "to") ||
    getStringField(record, "id") ||
    "unknown";

  return `${boundary}:${sessionRef}`;
}

function logLifecycle(
  phase: string,
  {
    boundary = "n/a",
    source = "n/a",
    hash = "n/a",
    reason = "n/a",
    detail,
    attempt = 0,
    retryType = "none",
  }: {
    boundary?: string;
    source?: string;
    hash?: string;
    reason?: string;
    detail?: string;
    attempt?: number;
    retryType?: string;
  } = {},
): void {
  const payload: Record<string, unknown> = {
    plugin: PLUGIN,
    phase,
    retryType,
    attempt,
    reason,
    boundary,
    source,
    hash,
  };

  if (detail) payload.detail = truncate(detail, 500);

  console.log(`[HintsInjector] ${JSON.stringify(payload)}`);
}

function readHintFile(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return normalizeContent(readFileSync(path, "utf-8"));
  } catch {
    return "";
  }
}

function capHintLength(content: string, maxChars: number): { text: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return { text: content, truncated: false };
  }

  let keepLength = Math.max(0, maxChars - 80);
  let body = content.slice(0, keepLength).trimEnd();

  let suffix = `\n\n...[Hints truncated: ${content.length - body.length} chars omitted]`;

  while (body.length > 0 && body.length + suffix.length > maxChars) {
    keepLength = Math.max(0, keepLength - 16);
    body = content.slice(0, keepLength).trimEnd();
    suffix = `\n\n...[Hints truncated: ${content.length - body.length} chars omitted]`;
  }

  if (body.length + suffix.length > maxChars) {
    return {
      text: suffix.slice(0, maxChars),
      truncated: true,
    };
  }

  return {
    text: `${body}${suffix}`,
    truncated: true,
  };
}

function resolveHints(projectRoot: string): ResolvedHints {
  const globalHintsPath = join(process.env.GSD_HOME || join(homedir(), ".gsd"), "HINTS.md");
  const projectHintsGsd = join(projectRoot, ".gsd", "HINTS.md");
  const projectHintsRoot = join(projectRoot, "HINTS.md");

  const segments: HintSegment[] = [];
  const seenContentHashes = new Set<string>();
  const dedupedSources: HintSource[] = [];

  const pushSegment = (source: HintSource, label: string, rawContent: string): void => {
    const content = normalizeContent(rawContent);
    if (!content) return;

    const hash = hashText(content);
    if (seenContentHashes.has(hash)) {
      dedupedSources.push(source);
      return;
    }

    seenContentHashes.add(hash);
    segments.push({ source, label, content, hash });
  };

  pushSegment("global", "Global Hints", readHintFile(globalHintsPath));

  const projectContent = existsSync(projectHintsGsd)
    ? readHintFile(projectHintsGsd)
    : readHintFile(projectHintsRoot);
  pushSegment("project", "Project Hints", projectContent);

  const mergedHints = segments
    .map((segment) => `### ${segment.label}\n\n${segment.content}`)
    .join("\n\n")
    .trim();

  if (!mergedHints) {
    return {
      text: "",
      hash: "none",
      source: "none",
      rawLength: 0,
      finalLength: 0,
      truncated: false,
      dedupedSources,
    };
  }

  const capped = capHintLength(mergedHints, MAX_HINTS_CHARS);

  return {
    text: capped.text,
    hash: hashText(capped.text),
    source: segments.map((segment) => segment.source).join("+"),
    rawLength: mergedHints.length,
    finalLength: capped.text.length,
    truncated: capped.truncated,
    dedupedSources,
  };
}

function rememberConversationBoundaryKey(key: string): boolean {
  if (state.seenConversationKeySet.has(key)) {
    return false;
  }

  state.seenConversationKeySet.add(key);
  state.seenConversationKeys.push(key);

  if (state.seenConversationKeys.length > MAX_TRACKED_BOUNDARY_KEYS) {
    const oldest = state.seenConversationKeys.shift();
    if (oldest) {
      state.seenConversationKeySet.delete(oldest);
    }
  }

  return true;
}

function buildSystemHintsBlock(hintsText: string, hash: string): string {
  return `${SYSTEM_HINTS_START} hash=${hash}\n\n${hintsText}\n\n${SYSTEM_HINTS_END}`;
}

function upsertSystemPromptHints(systemPrompt: string, hintsBlock: string): PromptUpsertResult {
  if (!systemPrompt) {
    return {
      systemPrompt: hintsBlock,
      action: "append",
    };
  }

  const existing = systemPrompt.match(SYSTEM_HINTS_BLOCK_RE)?.[0];
  if (!existing) {
    return {
      systemPrompt: `${systemPrompt}\n\n${hintsBlock}`,
      action: "append",
    };
  }

  if (existing === hintsBlock) {
    return {
      systemPrompt,
      action: "noop",
    };
  }

  return {
    systemPrompt: systemPrompt.replace(SYSTEM_HINTS_BLOCK_RE, hintsBlock),
    action: "replace",
  };
}

function logHintMaterialization(boundary: LifecycleBoundary, resolved: ResolvedHints): void {
  if (resolved.dedupedSources.length > 0) {
    logLifecycle("hints_source_deduped", {
      boundary,
      source: resolved.dedupedSources.join("+"),
      hash: resolved.hash,
      reason: "duplicate_content_removed",
    });
  }

  if (resolved.truncated) {
    logLifecycle("hints_truncated", {
      boundary,
      source: resolved.source,
      hash: resolved.hash,
      reason: "max_length_applied",
      detail: `raw=${resolved.rawLength},final=${resolved.finalLength},cap=${MAX_HINTS_CHARS}`,
    });
  }
}

function injectVisibleHints(
  pi: ExtensionAPI,
  boundary: Extract<LifecycleBoundary, "session_start" | "session_switch:new">,
  event: unknown,
  ctx: ExtensionContext,
): void {
  const resolved = resolveHints(ctx.cwd);

  if (!resolved.text) {
    logLifecycle("conversation_inject_skip", {
      boundary,
      source: "none",
      hash: "none",
      reason: "no_hints_found",
    });
    return;
  }

  logHintMaterialization(boundary, resolved);

  const dedupeKey = `${boundaryId(boundary, event)}:${resolved.hash}`;
  const duplicateBoundary = dedupeKey === state.lastConversationKey || !rememberConversationBoundaryKey(dedupeKey);
  if (duplicateBoundary) {
    state.lastConversationKey = dedupeKey;
    logLifecycle("conversation_inject_skip", {
      boundary,
      source: resolved.source,
      hash: resolved.hash,
      reason: "boundary_hash_duplicate",
      detail: dedupeKey,
    });
    return;
  }

  state.lastConversationKey = dedupeKey;

  pi.sendMessage({
    customType: "hints-injector",
    content: `${VISIBLE_HINTS_HEADER}${resolved.text}`,
    display: true,
  });

  logLifecycle("conversation_inject_sent", {
    boundary,
    source: resolved.source,
    hash: resolved.hash,
    reason: "visible_hints_sent",
    detail: `chars=${resolved.finalLength}`,
  });
}

export default async function registerExtension(pi: ExtensionAPI) {
  logLifecycle("factory_registered", {
    reason: "extension_factory_initialized",
    boundary: "session_start",
    source: "n/a",
    hash: "n/a",
  });

  // Session start: inject once for interactive session boot / clear.
  pi.on("session_start", (event, ctx) => {
    state.skipNextNewSwitchVisibleInjection = true;
    state.beforeAgentSeenAfterSessionStart = false;

    injectVisibleHints(pi, "session_start", event, ctx);
  });

  // Session switch: inject for new auto-mode unit sessions only.
  // If a new switch immediately follows session_start before any agent turn,
  // treat it as bootstrap duplicate and suppress one visible message.
  pi.on("session_switch", (event: any, ctx) => {
    if (event.reason !== "new") {
      logLifecycle("conversation_inject_skip", {
        boundary: "session_switch:new",
        source: "n/a",
        hash: "n/a",
        reason: "session_switch_non_new",
        detail: String(event.reason || "unknown"),
      });
      return;
    }

    if (state.skipNextNewSwitchVisibleInjection && !state.beforeAgentSeenAfterSessionStart) {
      state.skipNextNewSwitchVisibleInjection = false;
      logLifecycle("conversation_inject_skip", {
        boundary: "session_switch:new",
        source: "n/a",
        hash: "n/a",
        reason: "bootstrap_duplicate_after_session_start",
      });
      return;
    }

    state.skipNextNewSwitchVisibleInjection = false;
    injectVisibleHints(pi, "session_switch:new", event, ctx);
  });

  /**
   * Strong-constraint injection:
   * ensure hints are present in systemPrompt at before_agent_start boundary,
   * but upsert idempotently (append/replace/noop) to avoid duplicated blocks.
   */
  pi.on("before_agent_start", async (event, ctx) => {
    state.beforeAgentSeenAfterSessionStart = true;

    const boundary: LifecycleBoundary = "before_agent_start";
    const resolved = resolveHints(ctx.cwd);

    if (!resolved.text) {
      logLifecycle("system_prompt_skip", {
        boundary,
        source: "none",
        hash: "none",
        reason: "no_hints_found",
      });
      return;
    }

    logHintMaterialization(boundary, resolved);

    const currentSystemPrompt = String(event.systemPrompt || "");
    const hintsBlock = buildSystemHintsBlock(resolved.text, resolved.hash);
    const upsertResult = upsertSystemPromptHints(currentSystemPrompt, hintsBlock);

    logLifecycle(`system_prompt_${upsertResult.action}`, {
      boundary,
      source: resolved.source,
      hash: resolved.hash,
      reason:
        upsertResult.action === "noop"
          ? "hints_block_already_current"
          : "hints_block_upserted",
      detail: `chars=${resolved.finalLength}/${resolved.rawLength}`,
    });

    if (upsertResult.action === "noop") {
      return;
    }

    return {
      systemPrompt: upsertResult.systemPrompt,
    };
  });
}
