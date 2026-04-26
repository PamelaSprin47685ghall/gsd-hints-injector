import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type ExtensionApiLike = {
  on(event: "before_agent_start", handler: BeforeAgentStartHandler): void;
  on(event: "before_provider_request", handler: BeforeProviderRequestHandler): void;
};

type ExtensionContextLike = Record<string, never>;

type BeforeAgentStartEvent = {
  type: "before_agent_start";
  prompt?: string;
  systemPrompt: string;
};

type BeforeAgentStartResult = {
  systemPrompt?: string;
  message?: {
    customType: string;
    content: string;
    display: false;
    details?: Record<string, unknown>;
  };
};

type BeforeAgentStartHandler = (
  event: BeforeAgentStartEvent,
  ctx?: ExtensionContextLike,
) => BeforeAgentStartResult | undefined | Promise<BeforeAgentStartResult | undefined>;

type BeforeProviderRequestEvent = {
  type: "before_provider_request";
  payload: unknown;
  model?: { provider?: string; id?: string; api?: string };
};

type BeforeProviderRequestHandler = (
  event: BeforeProviderRequestEvent,
  ctx?: ExtensionContextLike,
) => unknown | Promise<unknown>;

type HintSource = {
  label: "Global" | "Project";
  path: string;
  content: string;
};

type DynamicExtraction = {
  systemPrompt: string;
  lines: string[];
  projectCwd?: string;
};

const DYNAMIC_SYSTEM_LINE_PATTERNS: RegExp[] = [
  /^Current date(?: and time)?:\s+.+$/,
  /^Current working directory:\s+.+$/,
];

const RESPONSE_API_NAMES = new Set(["openai-responses", "azure-openai-responses"]);

export default function hintsInjector(pi: ExtensionApiLike): void {
  pi.on("before_agent_start", async (event) => {
    return buildBeforeAgentStartResult(event.systemPrompt);
  });

  pi.on("before_provider_request", async (event) => {
    return stabilizeResponsesPayload(event);
  });
}

export function buildBeforeAgentStartResult(systemPrompt: string): BeforeAgentStartResult | undefined {
  const dynamic = extractDynamicSystemLines(systemPrompt);
  const hintsBlock = buildHintsBlock(loadHintSources(dynamic.projectCwd));
  const nextSystemPrompt = appendBlock(dynamic.systemPrompt, hintsBlock);
  const dynamicMessage = buildDynamicContextMessage(dynamic.lines);

  if (nextSystemPrompt === systemPrompt && !dynamicMessage) {
    return undefined;
  }

  return {
    ...(nextSystemPrompt !== systemPrompt ? { systemPrompt: nextSystemPrompt } : {}),
    ...(dynamicMessage ? { message: dynamicMessage } : {}),
  };
}

export function loadHintSources(projectCwd?: string): HintSource[] {
  const sources: HintSource[] = [];

  const gsdHome = process.env.GSD_HOME || join(homedir(), ".gsd");
  const globalPath = join(gsdHome, "HINTS.md");
  const globalContent = readTextFileIfPresent(globalPath);
  if (globalContent) {
    sources.push({ label: "Global", path: globalPath, content: globalContent });
  }

  if (!projectCwd) return sources;

  const projectGsdHintsPath = join(projectCwd, ".gsd", "HINTS.md");
  const projectRootHintsPath = join(projectCwd, "HINTS.md");
  const projectGsdContent = readTextFileIfPresent(projectGsdHintsPath);
  if (projectGsdContent) {
    sources.push({ label: "Project", path: projectGsdHintsPath, content: projectGsdContent });
  } else {
    const projectRootContent = readTextFileIfPresent(projectRootHintsPath);
    if (projectRootContent) {
      sources.push({ label: "Project", path: projectRootHintsPath, content: projectRootContent });
    }
  }

  return sources;
}

export function buildHintsBlock(sources: HintSource[]): string {
  if (sources.length === 0) return "";

  const sections = sources.map((source) => {
    return `## ${source.label} HINTS (${source.path})\n\n${source.content.trim()}`;
  });

  return `[HINTS — Stable Guidance]\n\nThese instructions come from HINTS.md files and are intentionally injected into the stable system prompt.\n\n${sections.join("\n\n")}`;
}

export function extractDynamicSystemLines(systemPrompt: string): DynamicExtraction {
  const movedLines: string[] = [];
  const keptLines: string[] = [];
  let projectCwd: string | undefined;

  for (const line of systemPrompt.split("\n")) {
    const trimmedLine = line.trim();
    const cwdMatch = trimmedLine.match(/^Current working directory:\s+(.+)$/);
    if (cwdMatch) projectCwd = cwdMatch[1];

    if (DYNAMIC_SYSTEM_LINE_PATTERNS.some((pattern) => pattern.test(trimmedLine))) {
      movedLines.push(trimmedLine);
    } else {
      keptLines.push(line);
    }
  }

  return {
    systemPrompt: collapseExcessBlankLines(keptLines.join("\n")).trimEnd(),
    lines: movedLines,
    projectCwd,
  };
}

export function stabilizeResponsesPayload(event: BeforeProviderRequestEvent): unknown {
  const payload = event.payload;
  if (!isRecord(payload)) return undefined;

  const isResponsesApi = RESPONSE_API_NAMES.has(event.model?.api ?? "");
  const looksLikeResponsesPayload = Array.isArray(payload.input) && ("prompt_cache_key" in payload || "store" in payload);
  if (!isResponsesApi && !looksLikeResponsesPayload) return undefined;

  let changed = false;
  const nextPayload: Record<string, unknown> = { ...payload };

  const stableCacheKey = resolveStablePromptCacheKey(nextPayload);
  if (stableCacheKey && nextPayload.prompt_cache_key !== stableCacheKey) {
    nextPayload.prompt_cache_key = stableCacheKey;
    changed = true;
  }

  if (Array.isArray(nextPayload.input)) {
    const stabilized = stabilizeResponsesInput(nextPayload.input);
    if (stabilized.changed) {
      nextPayload.input = stabilized.input;
      changed = true;
    }
  }

  return changed ? nextPayload : undefined;
}

export function stabilizeResponsesInput(input: unknown[]): { input: unknown[]; changed: boolean } {
  const callIdMap = new Map<string, string>();
  let messageIndex = 0;
  let functionCallIndex = 0;
  let changed = false;

  const stableCallIdFor = (callId: string): string => {
    const existing = callIdMap.get(callId);
    if (existing) return existing;
    const next = `call_${callIdMap.size}`;
    callIdMap.set(callId, next);
    return next;
  };

  const nextInput = input.map((item) => {
    if (!isRecord(item)) return item;

    if (item.type === "message" && item.role === "assistant" && typeof item.id === "string") {
      const stableId = `msg_${messageIndex++}`;
      if (item.id !== stableId) {
        changed = true;
        return { ...item, id: stableId };
      }
      return item;
    }

    if (item.type === "function_call") {
      let nextItem: Record<string, unknown> = item;
      const currentFunctionCallIndex = functionCallIndex++;

      if (typeof item.call_id === "string") {
        const stableCallId = stableCallIdFor(item.call_id);
        if (item.call_id !== stableCallId) {
          nextItem = nextItem === item ? { ...item } : nextItem;
          nextItem.call_id = stableCallId;
          changed = true;
        }
      }

      if (typeof item.id === "string") {
        const stableItemId = `fc_${currentFunctionCallIndex}`;
        if (item.id !== stableItemId) {
          nextItem = nextItem === item ? { ...item } : nextItem;
          nextItem.id = stableItemId;
          changed = true;
        }
      }

      return nextItem;
    }

    if (item.type === "function_call_output" && typeof item.call_id === "string") {
      const stableCallId = stableCallIdFor(item.call_id);
      if (item.call_id !== stableCallId) {
        changed = true;
        return { ...item, call_id: stableCallId };
      }
    }

    return item;
  });

  return { input: nextInput, changed };
}

function buildDynamicContextMessage(lines: string[]): BeforeAgentStartResult["message"] | undefined {
  if (lines.length === 0) return undefined;

  return {
    customType: "gsd-hints-dynamic-context",
    display: false,
    content: `[SYSTEM CONTEXT — Dynamic Runtime]\n\nThese lines were moved out of the stable system prompt for prompt-cache stability. Treat them as current runtime context for this turn.\n\n${lines.join("\n")}`,
    details: {
      movedLineCount: lines.length,
    },
  };
}

function appendBlock(systemPrompt: string, block: string): string {
  if (!block) return systemPrompt;
  const trimmedSystemPrompt = systemPrompt.trimEnd();
  if (!trimmedSystemPrompt) return block;
  return `${trimmedSystemPrompt}\n\n${block}`;
}

function readTextFileIfPresent(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const content = readFileSync(path, "utf8").trim();
    return content.length > 0 ? content : undefined;
  } catch {
    return undefined;
  }
}

function resolveStablePromptCacheKey(payload: Record<string, unknown>): string | undefined {
  const explicit = process.env.GSD_HINTS_PROMPT_CACHE_KEY?.trim();
  if (explicit) return explicit;

  const material = stablePromptCacheMaterial(payload.input);
  if (!material) return undefined;

  const digest = createHash("sha256").update(material).digest("hex").slice(0, 24);
  return `gsd-hints:${digest}`;
}

function stablePromptCacheMaterial(input: unknown): string | undefined {
  if (!Array.isArray(input)) return undefined;

  const officialPromptParts = input
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .filter((item) => item.role === "system" || item.role === "developer")
    .map((item) => {
      if (typeof item.content === "string") return item.content;
      if (!Array.isArray(item.content)) return "";
      return item.content
        .filter((block): block is Record<string, unknown> => isRecord(block))
        .map((block) => typeof block.text === "string" ? block.text : "")
        .filter(Boolean)
        .join("\n");
    })
    .filter(Boolean);

  return officialPromptParts.length > 0 ? officialPromptParts.join("\n\n") : undefined;
}

function collapseExcessBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
