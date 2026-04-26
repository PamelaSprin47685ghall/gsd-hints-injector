import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

const PLUGIN = "gsd-hints-injector";
const DEFAULT_MAX_HINTS_CHARS = 4000;

const SYSTEM_HINTS_START = "<!-- gsd-hints-injector:system-hints:start -->";
const SYSTEM_HINTS_END = "<!-- gsd-hints-injector:system-hints:end -->";

const STATIC_HINTS_SYSTEM_HEADER = `# System Auto-Injected HINTS

The following HINTS are stable user/project guidance. Treat them as system-level instructions for this session and prefer them over ad-hoc defaults when they apply.`;

const DYNAMIC_CONTEXT_MESSAGE_HEADER = `Prompt Dynamic Context

The following values were intentionally moved out of systemPrompt so provider-side system prompt caching can reuse the stable instructions.`;

const DYNAMIC_SYSTEM_PROMPT_LINE_PATTERNS = [
  {
    key: "date_time",
    pattern: /^Current date and time:\s+.+$/,
  },
  {
    key: "working_directory",
    pattern: /^Current working directory:\s+.+$/,
  },
] as const;

type HintSource = "global" | "project";
type UiNotifyLevel = "info" | "warning" | "error" | "success";

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

interface SystemPromptSplit {
  staticSystemPrompt: string;
  dynamicContext: string;
  removedDynamicKeys: string[];
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
  usage?: UsageLike;
}

interface ProviderModelLike {
  provider?: string;
  id?: string;
  api?: string;
}

interface HostApiProvider {
  stream: (model: any, context: any, options?: any) => any;
  streamSimple: (model: any, context: any, options?: any) => any;
}

interface HostPiAiModule {
  getApiProvider: (api: string) => HostApiProvider | undefined;
  registerApiProvider: (provider: { api: string; stream: HostApiProvider["stream"]; streamSimple: HostApiProvider["streamSimple"] }, sourceId?: string) => void;
}

const MAX_HINTS_CHARS = resolveMaxHintsChars();

let activeCwd = process.cwd();
let uiNotify: ((message: string, level?: UiNotifyLevel) => void) | null = null;
let uiSetStatus: ((key: string, text: string | undefined) => void) | null = null;
let lastCacheStatus: string | undefined;

function bindContext(ctx?: ExtensionContext): void {
  if (ctx?.cwd) activeCwd = ctx.cwd;

  const maybeUi = (ctx as { ui?: { notify?: unknown; setStatus?: unknown } } | undefined)?.ui;
  const maybeNotify = maybeUi?.notify;
  if (typeof maybeNotify === "function") {
    uiNotify = (message: string, level: UiNotifyLevel = "info") => {
      try {
        maybeNotify.call(maybeUi, message, level);
      } catch {}
    };
  }

  const maybeSetStatus = maybeUi?.setStatus;
  if (typeof maybeSetStatus === "function") {
    uiSetStatus = (key: string, text: string | undefined) => {
      try {
        maybeSetStatus.call(maybeUi, key, text);
      } catch {}
    };
  }
}

function resolveMaxHintsChars(): number {
  const raw = Number(process.env.GSD_HINTS_MAX_CHARS ?? "");
  return Number.isFinite(raw) && raw >= 500 ? Math.floor(raw) : DEFAULT_MAX_HINTS_CHARS;
}

function truncate(text: string, max = 320): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
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
  }: {
    boundary?: string;
    source?: string;
    hash?: string;
    reason?: string;
    detail?: string;
  } = {},
): void {
  if (!uiNotify) return;

  const payload: Record<string, unknown> = {
    plugin: PLUGIN,
    phase,
    reason,
    boundary,
    source,
    hash,
  };

  if (detail) payload.detail = truncate(detail, 500);
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
  if (content.length <= maxChars) return { text: content, truncated: false };

  let keepLength = Math.max(0, maxChars - 80);
  let body = content.slice(0, keepLength).trimEnd();
  let suffix = `\n\n...[Hints truncated: ${content.length - body.length} chars omitted]`;

  while (body.length > 0 && body.length + suffix.length > maxChars) {
    keepLength = Math.max(0, keepLength - 16);
    body = content.slice(0, keepLength).trimEnd();
    suffix = `\n\n...[Hints truncated: ${content.length - body.length} chars omitted]`;
  }

  return body.length + suffix.length > maxChars
    ? { text: suffix.slice(0, maxChars), truncated: true }
    : { text: `${body}${suffix}`, truncated: true };
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
  pushSegment("project", "Project Hints", existsSync(projectHintsGsd) ? readHintFile(projectHintsGsd) : readHintFile(projectHintsRoot));

  const mergedHints = segments.map((segment) => `### ${segment.label}\n\n${segment.content}`).join("\n\n").trim();
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

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeExistingStaticHints(systemPrompt: string): string {
  const start = escapeRegExp(SYSTEM_HINTS_START);
  const end = escapeRegExp(SYSTEM_HINTS_END);
  return systemPrompt.replace(new RegExp(`\\n*${start}[\\s\\S]*?${end}\\n*`, "g"), "\n").trimEnd();
}

function buildStaticHintsSystemSection(resolved: ResolvedHints): string {
  if (!resolved.text) return "";
  return `${SYSTEM_HINTS_START}\n${STATIC_HINTS_SYSTEM_HEADER}\n\nSource: ${resolved.source}\nHash: ${resolved.hash}\n\n${resolved.text}\n${SYSTEM_HINTS_END}`;
}

function splitSystemPromptForCache(systemPrompt: string): SystemPromptSplit {
  const staticLines: string[] = [];
  const dynamicLines: string[] = [];
  const removedDynamicKeys: string[] = [];

  for (const line of systemPrompt.replace(/\r\n?/g, "\n").split("\n")) {
    const match = DYNAMIC_SYSTEM_PROMPT_LINE_PATTERNS.find(({ pattern }) => pattern.test(line.trimEnd()));
    if (!match) {
      staticLines.push(line);
      continue;
    }

    dynamicLines.push(line.trimEnd());
    if (!removedDynamicKeys.includes(match.key)) removedDynamicKeys.push(match.key);
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

function logHintMaterialization(boundary: string, resolved: ResolvedHints): void {
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

  if (usage.cacheWrite > 0) return `cache warm W${formatTokenCount(usage.cacheWrite)}`;
  return "cache no-read";
}

function updateCacheStatus(message: unknown): void {
  if (!uiSetStatus || !isAssistantMessageLike(message)) return;

  const status = buildCacheStatus(message);
  if (status === lastCacheStatus) return;

  lastCacheStatus = status;
  uiSetStatus(PLUGIN, status);
  logLifecycle("provider_cache_status", {
    boundary: "message_end",
    source: "assistant_usage",
    reason: status.replace(/\s+/g, "_"),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isTextPart(part: unknown): part is Record<string, unknown> & { text: string } {
  if (!isRecord(part) || typeof part.text !== "string") return false;
  return part.type === "input_text" || part.type === "text" || part.type === "output_text";
}

function extractTextContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;

  const text = value.map((part) => (isTextPart(part) ? part.text : "")).filter(Boolean).join("\n");
  return text || undefined;
}

function replaceTextContent(value: unknown, text: string): unknown {
  if (typeof value === "string") return text;
  if (!Array.isArray(value)) return value;

  let replaced = false;
  return value.map((part) => {
    if (!isTextPart(part)) return part;
    if (replaced) return { ...part, text: "" };
    replaced = true;
    return { ...part, text };
  });
}

function extractStablePromptFromPayload(payload: Record<string, unknown>): string | undefined {
  const instructions = extractTextContent(payload.instructions);
  if (instructions) return instructions;

  const input = payload.input;
  if (!Array.isArray(input)) return undefined;

  const first = input.find((item) => isRecord(item) && (item.role === "system" || item.role === "developer"));
  return isRecord(first) ? extractTextContent(first.content) : undefined;
}

function buildStablePromptCacheKey(model: ProviderModelLike | undefined, stablePrompt: string): string {
  return `gsd-hints-${hashText([model?.provider || "unknown", model?.api || "unknown", model?.id || "unknown", stablePrompt].join("\n"))}`;
}

function mergeDynamicContexts(contexts: string[]): string {
  const lines = new Set<string>();
  for (const context of contexts) {
    for (const line of context.split("\n")) {
      const normalized = line.trimEnd();
      if (normalized) lines.add(normalized);
    }
  }
  return Array.from(lines).join("\n");
}

function extractDynamicPromptContextFromText(text: string): string | undefined {
  const headerIndex = text.indexOf(DYNAMIC_CONTEXT_MESSAGE_HEADER);
  if (headerIndex < 0) return undefined;

  const afterHeader = text.slice(headerIndex + DYNAMIC_CONTEXT_MESSAGE_HEADER.length);
  return afterHeader.replace(/\[end system notification\][\s\S]*$/u, "").trim() || undefined;
}

function extractDynamicPromptContextFromItem(item: unknown): string | undefined {
  if (!isRecord(item) || item.role !== "user") return undefined;

  const text = extractTextContent(item.content);
  if (!text) return undefined;

  return text.includes("[system notification — type: prompt-dynamic-context;") || text.includes(DYNAMIC_CONTEXT_MESSAGE_HEADER)
    ? extractDynamicPromptContextFromText(text)
    : undefined;
}

function buildResponsesDynamicContextItem(dynamicContext: string): Record<string, unknown> {
  return {
    role: "user",
    content: [{ type: "input_text", text: buildDynamicContextMessage(dynamicContext) }],
  };
}

function containsManagedSystemPrompt(text: string): boolean {
  return text.includes(SYSTEM_HINTS_START) || DYNAMIC_SYSTEM_PROMPT_LINE_PATTERNS.some(({ pattern }) => pattern.test(text));
}

function buildRuntimeDynamicContext(projectRoot: string): string {
  const dateTime = new Date().toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });

  return `Current date and time: ${dateTime}\nCurrent working directory: ${projectRoot}`;
}

function shapeProviderPayload(payload: unknown, model: ProviderModelLike | undefined, projectRoot: string): unknown | undefined {
  if (!isRecord(payload)) return undefined;

  const resolved = resolveHints(projectRoot);
  const nextPayload: Record<string, unknown> = { ...payload };
  const dynamicContexts: string[] = [];
  let changed = false;
  let promptMaterialFound = false;

  const shapePromptValue = (value: unknown): unknown => {
    const text = extractTextContent(value);
    if (!text || !containsManagedSystemPrompt(text)) return value;

    promptMaterialFound = true;
    const split = applyStaticPromptRebalance(text, resolved);
    if (split.dynamicContext) dynamicContexts.push(split.dynamicContext);
    if (split.staticSystemPrompt === text) return value;

    changed = true;
    return replaceTextContent(value, split.staticSystemPrompt);
  };

  if (payload.instructions !== undefined) {
    nextPayload.instructions = shapePromptValue(payload.instructions);
  }

  if (Array.isArray(payload.input)) {
    const input = [...payload.input];
    let inputChanged = false;
    const systemIndex = input.findIndex((item) => isRecord(item) && (item.role === "system" || item.role === "developer"));

    if (systemIndex >= 0) {
      const item = input[systemIndex];
      if (isRecord(item)) {
        const shapedContent = shapePromptValue(item.content);
        if (shapedContent !== item.content) {
          input[systemIndex] = { ...item, content: shapedContent };
          inputChanged = true;
        }
      }
    }

    let latestDynamicContextFromInput: string | undefined;
    const withoutPriorDynamicContext = input.filter((item) => {
      const dynamicContextFromItem = extractDynamicPromptContextFromItem(item);
      if (!dynamicContextFromItem) return true;

      latestDynamicContextFromInput = dynamicContextFromItem;
      inputChanged = true;
      promptMaterialFound = true;
      return false;
    });

    const dynamicContext = latestDynamicContextFromInput || mergeDynamicContexts(dynamicContexts) || (promptMaterialFound ? buildRuntimeDynamicContext(projectRoot) : "");
    if (dynamicContext) {
      nextPayload.input = [buildResponsesDynamicContextItem(dynamicContext), ...withoutPriorDynamicContext];
      changed = true;
    } else if (inputChanged) {
      nextPayload.input = withoutPriorDynamicContext;
      changed = true;
    }
  }

  const stablePrompt = extractStablePromptFromPayload(nextPayload);
  if (typeof payload.prompt_cache_key === "string" && stablePrompt && promptMaterialFound) {
    const nextCacheKey = buildStablePromptCacheKey(model, stablePrompt);
    if (payload.prompt_cache_key !== nextCacheKey) {
      nextPayload.prompt_cache_key = nextCacheKey;
      changed = true;
      logLifecycle("provider_prompt_cache_key_rebalanced", {
        boundary: "before_provider_request",
        source: model?.provider || "unknown",
        hash: hashText(stablePrompt),
        reason: "stable_system_prompt_key",
        detail: `api=${model?.api || "unknown"};model=${model?.id || "unknown"}`,
      });
    }
  }

  if (changed) {
    logHintMaterialization("before_provider_request", resolved);
    logLifecycle("provider_payload_prompt_rebalanced", {
      boundary: "before_provider_request",
      source: resolved.source,
      hash: stablePrompt ? hashText(stablePrompt) : resolved.hash,
      reason: "actual_outbound_payload_shaped",
    });
  }

  return changed ? nextPayload : undefined;
}

function isResponsesApi(model: ProviderModelLike | undefined): boolean {
  return model?.api === "openai-responses" || model?.api === "azure-openai-responses" || model?.api === "openai-codex-responses";
}

function isHostPiAiModule(value: unknown): value is HostPiAiModule {
  return isRecord(value) && typeof value.getApiProvider === "function" && typeof value.registerApiProvider === "function";
}

function resolveHostPiAiSpecifiers(): string[] {
  const specifiers: string[] = [];

  if (process.env.GSD_HINTS_HOST_PI_AI_PATH) specifiers.push(process.env.GSD_HINTS_HOST_PI_AI_PATH);

  const entrypoint = process.argv[1];
  if (!entrypoint) return specifiers;

  let current = dirname(entrypoint);
  for (let depth = 0; depth < 8; depth += 1) {
    specifiers.push(join(current, "node_modules", "@gsd", "pi-ai", "dist", "index.js"));
    specifiers.push(join(current, "packages", "pi-ai", "dist", "index.js"));

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return specifiers.filter((specifier, index, all) => all.indexOf(specifier) === index && existsSync(specifier));
}

async function importHostPiAi(): Promise<HostPiAiModule | undefined> {
  for (const specifier of resolveHostPiAiSpecifiers()) {
    try {
      const module = await import(pathToFileURL(specifier).href);
      if (isHostPiAiModule(module)) return module;
    } catch {}
  }

  return undefined;
}

function withPromptPayloadShaper(options: any, fallbackModel: ProviderModelLike): any {
  const priorOnPayload = typeof options?.onPayload === "function" ? options.onPayload : undefined;

  return {
    ...options,
    onPayload: async (payload: unknown, model: ProviderModelLike | undefined) => {
      const priorPayload = priorOnPayload ? await priorOnPayload(payload, model) : payload;
      return shapeProviderPayload(priorPayload, model || fallbackModel, activeCwd) ?? priorPayload;
    },
  };
}

async function installHostProviderPromptWrappers(): Promise<void> {
  const globalState = globalThis as typeof globalThis & { __gsdHintsProviderWrappers?: Map<string, HostApiProvider> };
  globalState.__gsdHintsProviderWrappers ??= new Map<string, HostApiProvider>();

  const hostPiAi = await importHostPiAi();
  if (!hostPiAi) {
    logLifecycle("host_provider_registry_unavailable", {
      boundary: "provider_wrapper_install",
      source: "@gsd/pi-ai",
      reason: "host_module_resolution_failed",
    });
    return;
  }

  for (const api of ["openai-responses", "azure-openai-responses", "openai-codex-responses"]) {
    const provider = hostPiAi.getApiProvider(api);
    if (!provider) {
      logLifecycle("host_provider_registry_skip", {
        boundary: "provider_wrapper_install",
        source: api,
        reason: "api_provider_not_registered",
      });
      continue;
    }

    if (globalState.__gsdHintsProviderWrappers.get(api) === provider) continue;

    hostPiAi.registerApiProvider(
      {
        api,
        stream: (model: any, context: any, options?: any) => provider.stream(model, context, withPromptPayloadShaper(options, model)),
        streamSimple: (model: any, context: any, options?: any) => provider.streamSimple(model, context, withPromptPayloadShaper(options, model)),
      },
      `${PLUGIN}:prompt-payload-shaper`,
    );

    const registeredProvider = hostPiAi.getApiProvider(api);
    if (registeredProvider) globalState.__gsdHintsProviderWrappers.set(api, registeredProvider);

    logLifecycle("host_provider_prompt_wrapper_installed", {
      boundary: "provider_wrapper_install",
      source: api,
      reason: "api_provider_wrapped",
    });
  }
}

export default async function registerExtension(pi: ExtensionAPI) {
  await installHostProviderPromptWrappers();

  pi.on("session_start", async (_event, ctx) => {
    bindContext(ctx);
    await installHostProviderPromptWrappers();
    logLifecycle("factory_registered", { boundary: "session_start", reason: "extension_ready" });
  });

  pi.on("model_select", async (_event, ctx) => {
    bindContext(ctx);
    await installHostProviderPromptWrappers();
  });

  pi.on("message_end", (event: any, ctx) => {
    bindContext(ctx);
    updateCacheStatus(event.message);
  });

  pi.on("before_provider_request", async (event: any, ctx) => {
    bindContext(ctx);
    await installHostProviderPromptWrappers();
    return shapeProviderPayload(event.payload, event.model, ctx.cwd);
  });

  pi.on("before_agent_start", async (event: any, ctx) => {
    bindContext(ctx);
    await installHostProviderPromptWrappers();

    const resolved = resolveHints(ctx.cwd);
    logHintMaterialization("before_agent_start", resolved);

    const split = applyStaticPromptRebalance(event.systemPrompt, resolved);
    const result: { systemPrompt?: string; message?: { customType: string; content: string; display: boolean; details?: unknown } } = {};

    if (split.staticSystemPrompt !== event.systemPrompt) {
      result.systemPrompt = split.staticSystemPrompt;
      logLifecycle("system_prompt_rebalanced", {
        boundary: "before_agent_start",
        source: resolved.source,
        hash: hashText(split.staticSystemPrompt),
        reason: resolved.text ? "static_hints_in_system_prompt" : "dynamic_lines_removed",
        detail: `removed=${split.removedDynamicKeys.join("+") || "none"};hintsHash=${resolved.hash}`,
      });
    }

    if (split.dynamicContext && !isResponsesApi(ctx.model)) {
      const dynamicHash = hashText(split.dynamicContext);
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
        reason: "non_responses_provider_prompt_message",
      });
    }

    return Object.keys(result).length > 0 ? result : undefined;
  });
}
