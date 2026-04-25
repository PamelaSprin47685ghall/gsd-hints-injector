# GSD Hints Injector

Injects `HINTS.md` (global + project) into GSD while also **rebalancing the initial prompt into cache-stable systemPrompt content and dynamic prompt context**.

The goal is provider-side cache friendliness: large stable instructions stay in `systemPrompt`, while values that can change between sessions/turns (date/time, working directory) are moved into a hidden prompt message.

## Installation

```bash
gsd install git:github.com/PamelaSprin47685ghall/gsd-hints-injector
```

## Usage

1. **Global hints:** create `~/.gsd/HINTS.md` (or `${GSD_HOME}/HINTS.md` if `GSD_HOME` is set).
2. **Project hints:** create `.gsd/HINTS.md` or `HINTS.md` in project root.

Priority remains:

1. Global (`~/.gsd/HINTS.md`)
2. Project (`.gsd/HINTS.md`, fallback to `HINTS.md`)

## Prompt Rebalancing

### Static: kept in `systemPrompt`

- Pi/GSD role and tool instructions from GSD's base prompt.
- Large stable descriptions, guidelines, docs pointers, skill table, and project context already assembled by GSD.
- Global/project `HINTS.md`, wrapped in `gsd-hints-injector` markers.

### Dynamic: moved to prompt context

- `Current date and time: ...`
- `Current working directory: ...`

These lines are removed from `systemPrompt` by the `before_agent_start` hook and sent once per real session boundary as a hidden custom message with `customType: "prompt-dynamic-context"`.

## What the ../gsd-2 analysis found

Relevant source paths in `../gsd-2`:

- `packages/pi-coding-agent/src/core/system-prompt.ts`
  - `buildSystemPrompt()` constructs the base `systemPrompt`.
  - Stable sections: assistant role, tool list, guidelines, Pi docs pointers, append section, project context files, skills.
  - Dynamic tail: `Current date and time: ...` and `Current working directory: ...` are appended at the end for both default and custom prompts.
- `packages/pi-coding-agent/src/core/agent-session.ts`
  - `prompt()` receives the human prompt, expands it, then calls `emitBeforeAgentStart(expandedText, images, this._baseSystemPrompt)`.
  - Extension-provided `message` results are appended to the current prompt messages; extension-provided `systemPrompt` replaces the turn's system prompt.
- `packages/pi-coding-agent/src/core/extensions/runner.ts`
  - Chains `before_agent_start` handlers by passing the current `systemPrompt` through each handler.
  - Returns `systemPrompt` only when modified and gathers custom prompt messages.
- `packages/pi-coding-agent/src/core/messages.ts`
  - Custom extension messages are converted to LLM-visible user messages wrapped as automated system notifications, so hidden dynamic context still reaches the model without living in `systemPrompt`.

## Injection Boundaries

- `session_start` → marks the next agent turn as needing a dynamic prompt-context message.
- `session_switch` (`reason === "new"`) → marks the next agent turn as needing fresh dynamic prompt context for new auto-mode unit sessions.
  - If a `session_switch:new` immediately follows `session_start` before any agent turn, it is treated as bootstrap duplicate and suppressed once.
- `before_agent_start` → performs the actual split:
  - strips dynamic date/cwd lines from `systemPrompt`,
  - appends static HINTS to `systemPrompt`,
  - emits hidden dynamic prompt context once for the current boundary.

## 设计原则（SystemPrompt 静态化 + Prompt 动态化）

1. **静态大块进 systemPrompt**
   - HINTS、工具说明、长期规则、项目上下文等稳定内容放进 `systemPrompt`，让服务端缓存更容易命中。

2. **动态小块进 prompt**
   - 时间、当前目录等会变化的值不再污染 `systemPrompt`。
   - 这些值通过隐藏 custom message 注入当前 prompt/context。

3. **不确定的默认动态**
   - 插件只移动明确识别的 GSD 动态尾行。
   - 未识别内容保留在 `systemPrompt`，避免误删规则或破坏其他扩展。

4. **可预测、可审计、可回放**
   - HINTS 内容去重并限长。
   - 关键分支输出统一结构化诊断字段（`plugin/phase/retryType/attempt/reason` + `boundary/source/hash`）。

## Dedupe + Length Cap

- Source dedupe: if global and project hint content is identical (after normalization), duplicated content is dropped.
- Length cap: merged hints are capped to `GSD_HINTS_MAX_CHARS` (default `4000`) with truncation notice.
- Static marker replacement: prior `gsd-hints-injector` system HINTS blocks are removed before appending the latest static HINTS block.

## Diagnostics

Lifecycle diagnostics are emitted as structured JSON with unified fields:

- `plugin`, `phase`, `retryType`, `attempt`, `reason`
- plus prompt-split fields: `boundary`, `source`, `hash`

Important phases:

- `prompt_rebalance_boundary`
- `prompt_rebalance_boundary_skip`
- `system_prompt_rebalanced`
- `dynamic_prompt_context_sent`
- `dynamic_prompt_context_skip`
- `hints_source_deduped`
- `hints_truncated`

## Re-runnable Verification Steps

```bash
# 1) hints-injector regression contract
node --test index.test.mjs

# 2) prompt split markers
rg -n "before_agent_start|SYSTEM_HINTS_START|prompt-dynamic-context|Current date and time|Current working directory" index.ts

# 3) verify HINTS are not sent as visible boundary spam anymore
rg -n "sendMessage|VISIBLE_HINTS_HEADER|conversation_inject_sent" index.ts && exit 1 || true
```

Pass criteria:
- Each command exits `0`.
- Step (2) matches the prompt split implementation markers.
- Step (3) returns no matches (no visible HINTS boundary spam path).
