import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

export default async function registerExtension(pi: ExtensionAPI) {
  /**
   * Helper to resolve and read HINTS.md files.
   * Priority: ~/.gsd/HINTS.md (Global) -> .gsd/HINTS.md (Project) -> ./HINTS.md (Project)
   */
  const getHints = (projectRoot: string) => {
    const globalHintsPath = join(process.env.GSD_HOME || join(homedir(), ".gsd"), "HINTS.md");
    const projectHintsGsd = join(projectRoot, ".gsd", "HINTS.md");
    const projectHintsRoot = join(projectRoot, "HINTS.md");

    let hintsText = "";

    // 1. Global Hints
    if (existsSync(globalHintsPath)) {
      try {
        const content = readFileSync(globalHintsPath, "utf-8").trim();
        if (content) hintsText += `### Global Hints\n\n${content}\n\n`;
      } catch (e) {}
    }

    // 2. Project Hints
    let projectContent = "";
    if (existsSync(projectHintsGsd)) {
      try { projectContent = readFileSync(projectHintsGsd, "utf-8").trim(); } catch (e) {}
    } else if (existsSync(projectHintsRoot)) {
      try { projectContent = readFileSync(projectHintsRoot, "utf-8").trim(); } catch (e) {}
    }

    if (projectContent) {
      hintsText += `### Project Hints\n\n${projectContent}\n\n`;
    }

    return hintsText.trim();
  };

  /**
   * Visible injection: Injects a message at the start of a session or a new Auto Mode unit.
   * By calling this on session_start/switch, we ensure it appears BEFORE any user/auto prompt.
   */
  const injectToConversation = async (event: any, ctx: ExtensionContext) => {
    // Only trigger for new sessions (start) or new auto-mode unit sessions (switch with reason: "new")
    if (event.type === "session_switch" && event.reason !== "new") {
      return;
    }

    const hints = getHints(ctx.cwd);
    if (hints) {
      pi.sendMessage({
        customType: "hints-injector",
        content: `**System Auto-Injected HINTS:**\n\nPlease adhere to the following hints for this session:\n\n${hints}`,
        display: true
      });
    }
  };

  // 监听 Session 启动 (pi 启动或 /clear)
  pi.on("session_start", injectToConversation);
  
  // 监听 Session 切换 (Auto Mode 下产生的每个 Unit Session)
  // GSD2 的 runUnit 会等待 newSession 完成后再发送 Prompt，因此这里发送的 Hints 会出现在最前面。
  pi.on("session_switch", injectToConversation);

  /**
   * Authority injection: Also inject hints into the systemPrompt for EVERY turn.
   * This ensures the agent is strictly bound by the hints even if conversation history is long.
   */
  pi.on("before_agent_start", async (event, ctx) => {
    const hints = getHints(ctx.cwd);
    if (hints) {
      return {
        systemPrompt: `${event.systemPrompt}\n\n[USER-DEFINED HINTS — CRITICAL: ADHERE TO THESE RULES]\n\n${hints}`
      };
    }
  });
}
