import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

const PLUGIN = "gsd-hints-injector";
const DEFAULT_MAX_HINTS_CHARS = 4000;

const SYSTEM_HINTS_START = "<!-- gsd-hints-injector:system-hints:start -->";
const SYSTEM_HINTS_END = "<!-- gsd-hints-injector:system-hints:end -->";

const STATIC_HINTS_SYSTEM_HEADER = `# System Auto-Injected HINTS

The following HINTS are stable user/project guidance. Treat them as system-level instructions for this session and prefer them over ad-hoc defaults when they apply.`;

const DYNAMIC_CONTEXT_MESSAGE_HEADER = `Prompt Dynamic Context

The following values were intentionally moved out of systemPrompt so provider-side system prompt caching can reuse the stable instructions.`;

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

interface DynamicLinePattern {
  key: "date_time" | "working_directory";
  pattern: RegExp;
}

interface SystemPromptSplit {
  staticSystemPrompt: string;
  dynamicContext: string;
  removedDynamicKeys: string[];
}

interface RuntimeState {
  skipNextNewSwitchDynamicInjection: boolean;
  agentStartedAfterSessionStart: boolean;
  pendingDynamicPromptContext: boolean;
  lastStaticPromptHash?: string;
  lastDynamicContextHash?: string;
  lastCacheStatus?: string;
}

interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

interface AssistantMessageLike {
  role: "assistant";
  api?: string;
  provider?: string;
  model?: string;
  usage?: UsageLike;
}

const state: RuntimeState = {
  skipNextNewSwitchDynamicInjection: false,
  agentStartedAfterSessionStart: false,
  pendingDynamicPromptContext: true,
  lastStaticPromptHash: undefined,
  lastDynamicContextHash: undefined,
  lastCacheStatus: undefined,
};

const MAX_HINTS_CHARS = resolveMaxHintsChars();

const DYNAMIC_SYSTEM_PROMPT_LINE_PATTERNS: DynamicLinePattern[] = [
  {
    key: "date_time",
    pattern: /^Current date and time:\s+.+$/,
  },
  {
    key: "working_directory",
    pattern: /^Current working directory:\s+.+$/,
  },
];

type UiNotifyLevel = "info" | "warning" | "error" | "success";
let uiNotify: ((message: string, level?: UiNotifyLevel) => void) | null = null;
let uiSetStatus: ((key: string, text: string | undefined) => void) | null = null;

function bindUiControls(ctx?: ExtensionContext): void {
  const maybeUi = (ctx as { ui?: { notify?: unknown; setStatus?: unknown } } | undefined)?.ui;
  const maybeNotify = maybeUi?.notify;
  if (typeof maybeNotify === "function") {
    uiNotify = (message: string, level: UiNotifyLevel = "info") => {
      try {
        maybeNotify.call(maybeUi, message, level);
      } catch {
        // Keep prompt shaping non-blocking even if UI notification fails.
      }
    };
  }

  const maybeSetStatus = maybeUi?.setStatus;
  if (typeof maybeSetStatus === "function") {
    uiSetStatus = (key: string, text: string | undefined) => {
      try {
        maybeSetStatus.call(maybeUi, key, text);
      } catch {
        // Keep prompt shaping non-blocking even if footer status updates fail.
      }
    };
  }
}

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

  if (!uiNotify) return;
  uiNotify(`[HintsInjector] ${JSON.stringify(payload)}`, "info");
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

function removeExistingStaticHints(systemPrompt: string): string {
  const start = escapeRegExp(SYSTEM_HINTS_START);
  const end = escapeRegExp(SYSTEM_HINTS_END);
  return systemPrompt.replace(new RegExp(`\\n*${start}[\\s\\S]*?${end}\\n*`, "g"), "\n").trimEnd();
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildStaticHintsSystemSection(resolved: ResolvedHints): string {
  if (!resolved.text) return "";

  return `${SYSTEM_HINTS_START}\n${STATIC_HINTS_SYSTEM_HEADER}\n\nSource: ${resolved.source}\nHash: ${resolved.hash}\n\n${resolved.text}\n${SYSTEM_HINTS_END}`;
}

function splitSystemPromptForCache(systemPrompt: string): SystemPromptSplit {
  const normalized = systemPrompt.replace(/\r\n?/g, "\n");
  const staticLines: string[] = [];
  const dynamicLines: string[] = [];
  const removedDynamicKeys: string[] = [];

  for (const line of normalized.split("\n")) {
    const match = DYNAMIC_SYSTEM_PROMPT_LINE_PATTERNS.find(({ pattern }) => pattern.test(line.trimEnd()));
    if (match) {
      dynamicLines.push(line.trimEnd());
      if (!removedDynamicKeys.includes(match.key)) {
        removedDynamicKeys.push(match.key);
      }
      continue;
    }
    staticLines.push(line);
  }

  return {
    staticSystemPrompt: staticLines.join("\n").replace(/\n{3,}$/g, "\n\n").trimEnd(),
    dynamicContext: dynamicLines.join("\n").trim(),
    removedDynamicKeys,
  };
}

function applyStaticPromptRebalance(systemPrompt: string, resolved: ResolvedHints): SystemPromptSplit {
  const split = splitSystemPromptForCache(systemPrompt);
  const withoutPriorHints = removeExistingStaticHints(split.staticSystemPrompt);
  const staticHints = buildStaticHintsSystemSection(resolved);

  return {
    ...split,
    staticSystemPrompt: staticHints ? `${withoutPriorHints}\n\n${staticHints}`.trimEnd() : withoutPriorHints,
  };
}

function buildDynamicContextMessage(dynamicContext: string): string {
  return `${DYNAMIC_CONTEXT_MESSAGE_HEADER}\n\n${dynamicContext}`;
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

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 100) / 10}k`;
  return String(tokens);
}

function isAssistantMessageLike(message: unknown): message is AssistantMessageLike {
  return Boolean(message && typeof message === "object" && (message as { role?: unknown }).role === "assistant");
}

function buildCacheStatus(message: AssistantMessageLike): string {
  const usage = message.usage;
  if (!usage) return "cache n/a";

  const inputSideTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (usage.cacheRead > 0) {
    const hitRate = inputSideTokens > 0 ? Math.round((usage.cacheRead / inputSideTokens) * 100) : 100;
    return `cache hit ${hitRate}% R${formatTokenCount(usage.cacheRead)}`;
  }

  if (usage.cacheWrite > 0) {
    return `cache warm W${formatTokenCount(usage.cacheWrite)}`;
  }

  return "cache no-read";
}

function updateCacheStatus(message: unknown): void {
  if (!uiSetStatus || !isAssistantMessageLike(message)) return;

  const status = buildCacheStatus(message);
  if (status === state.lastCacheStatus) return;

  state.lastCacheStatus = status;
  uiSetStatus(PLUGIN, status);

  logLifecycle("provider_cache_status", {
    boundary: "message_end",
    source: "assistant_usage",
    hash: "n/a",
    reason: status.replace(/\s+/g, "_"),
  });
}

export default async function registerExtension(pi: ExtensionAPI) {
  logLifecycle("factory_registered", {
    reason: "extension_factory_initialized",
    boundary: "session_start",
    source: "n/a",
    hash: "n/a",
  });

  // Session start: mark the first prompt as needing dynamic context (date/cwd)
  // because those values are stripped out of systemPrompt for cacheability.
  pi.on("session_start", (_event, ctx) => {
    bindUiControls(ctx);
    state.skipNextNewSwitchDynamicInjection = true;
    state.agentStartedAfterSessionStart = false;
    state.pendingDynamicPromptContext = true;

    logLifecycle("prompt_rebalance_boundary", {
      boundary: "session_start",
      reason: "dynamic_context_pending",
    });
  });

  // Mark that the session has started running agent turns.
  // Used to avoid suppressing legitimate later session_switch:new boundaries.
  pi.on("agent_start", () => {
    state.agentStartedAfterSessionStart = true;
  });

  // Provider cache telemetry arrives on the assistant message usage object after
  // the upstream response completes. Show only what the provider reported.
  pi.on("message_end", (event: any, ctx) => {
    bindUiControls(ctx);
    updateCacheStatus(event.message);
  });

  // Session switch: a new auto-mode unit may rebuild cwd/date in the base prompt.
  // Keep the static system prompt stable and move those changing values to prompt context.
  pi.on("session_switch", (event: any, ctx) => {
    bindUiControls(ctx);
    if (event.reason !== "new") {
      logLifecycle("prompt_rebalance_boundary_skip", {
        boundary: "session_switch:new",
        source: "n/a",
        hash: "n/a",
        reason: "session_switch_non_new",
        detail: String(event.reason || "unknown"),
      });
      return;
    }

    if (state.skipNextNewSwitchDynamicInjection && !state.agentStartedAfterSessionStart) {
      state.skipNextNewSwitchDynamicInjection = false;
      logLifecycle("prompt_rebalance_boundary_skip", {
        boundary: "session_switch:new",
        source: "n/a",
        hash: "n/a",
        reason: "bootstrap_duplicate_after_session_start",
      });
      return;
    }

    state.skipNextNewSwitchDynamicInjection = false;
    state.pendingDynamicPromptContext = true;
    logLifecycle("prompt_rebalance_boundary", {
      boundary: "session_switch:new",
      reason: "dynamic_context_pending",
    });
  });

  // Per turn: return a cache-stable systemPrompt and, only at a real session
  // boundary, add a hidden custom prompt message with dynamic values.
  pi.on("before_agent_start", (event: any, ctx) => {
    bindUiControls(ctx);

    const resolved = resolveHints(ctx.cwd);
    logHintMaterialization("before_agent_start", resolved);

    const split = applyStaticPromptRebalance(event.systemPrompt, resolved);
    const staticHash = hashText(split.staticSystemPrompt);
    const dynamicHash = split.dynamicContext ? hashText(split.dynamicContext) : "none";

    if (staticHash !== state.lastStaticPromptHash) {
      state.lastStaticPromptHash = staticHash;
      logLifecycle("system_prompt_rebalanced", {
        boundary: "before_agent_start",
        source: resolved.source,
        hash: staticHash,
        reason: resolved.text ? "static_hints_in_system_prompt" : "dynamic_lines_removed",
        detail: `removed=${split.removedDynamicKeys.join("+") || "none"};hintsHash=${resolved.hash}`,
      });
    }

    const result: { systemPrompt?: string; message?: { customType: string; content: string; display: boolean; details?: unknown } } = {};

    if (split.staticSystemPrompt !== event.systemPrompt) {
      result.systemPrompt = split.staticSystemPrompt;
    }

    if (state.pendingDynamicPromptContext && split.dynamicContext) {
      state.pendingDynamicPromptContext = false;
      state.lastDynamicContextHash = dynamicHash;
      result.message = {
        customType: "prompt-dynamic-context",
        content: buildDynamicContextMessage(split.dynamicContext),
        display: false,
        details: {
          plugin: PLUGIN,
          movedFrom: "systemPrompt",
          dynamicKeys: split.removedDynamicKeys,
          hash: dynamicHash,
        },
      };

      logLifecycle("dynamic_prompt_context_sent", {
        boundary: "before_agent_start",
        source: "system_prompt_dynamic_lines",
        hash: dynamicHash,
        reason: "moved_to_prompt_message",
        detail: `keys=${split.removedDynamicKeys.join("+")}`,
      });
    } else if (split.dynamicContext) {
      logLifecycle("dynamic_prompt_context_skip", {
        boundary: "before_agent_start",
        source: "system_prompt_dynamic_lines",
        hash: dynamicHash,
        reason: "already_sent_for_boundary",
        detail: `last=${state.lastDynamicContextHash || "none"}`,
      });
    }

    return Object.keys(result).length > 0 ? result : undefined;
  });
}
