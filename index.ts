import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";

export default async function registerExtension(pi: ExtensionAPI) {
  const injectHints = async (event?: any) => {
    // 忽略恢复(resume)旧 session 的情况，仅在全新 session（包括 auto mode 的每个阶段）触发
    if (event && event.type === "session_switch" && event.reason !== "new") {
      return;
    }

    // 1. 解析全局 HINTS 路径 (~/.gsd/HINTS.md)
    const globalHintsPath = join(process.env.GSD_HOME || join(homedir(), ".gsd"), "HINTS.md");
    
    // 2. 解析项目级 HINTS 路径 (优先找 .gsd/HINTS.md，其次找项目根目录 HINTS.md)
    const projectRoot = process.cwd();
    const projectHintsGsd = join(projectRoot, ".gsd", "HINTS.md");
    const projectHintsRoot = join(projectRoot, "HINTS.md");

    let hintsText = "";

    // 读取全局提示
    if (existsSync(globalHintsPath)) {
      try {
        const content = readFileSync(globalHintsPath, "utf-8").trim();
        if (content) hintsText += `### Global Hints\n\n${content}\n\n`;
      } catch (e) {}
    }

    // 读取项目提示
    let projectContent = "";
    if (existsSync(projectHintsGsd)) {
      try { projectContent = readFileSync(projectHintsGsd, "utf-8").trim(); } catch (e) {}
    } else if (existsSync(projectHintsRoot)) {
      try { projectContent = readFileSync(projectHintsRoot, "utf-8").trim(); } catch (e) {}
    }

    if (projectContent) {
      hintsText += `### Project Hints\n\n${projectContent}\n\n`;
    }

    hintsText = hintsText.trim();

    // 如果存在任何提示，将其注入到当前 Session
    if (hintsText) {
      const finalContent = `**System Auto-Injected HINTS:**\n\nPlease adhere to the following hints for this session:\n\n${hintsText}`;

      // 使用 sendMessage 注入消息。
      // display: true 确保它会在终端 UI 上显式展示。
      // 不传 triggerTurn 选项，因此它会默默塞入当前上下文的开头，紧接着用户输入或 Auto 阶段的 Prompt 就会正常发出。
      pi.sendMessage({
        customType: "hints-injector",
        content: finalContent,
        display: true
      });
    }
  };

  // 监听插件启动时的首个 Session
  pi.events.on("session_start", injectHints);
  // 监听后续所有新产生的 Session (涵盖 Auto Mode 下不停切换的 unit session)
  pi.events.on("session_switch", injectHints);
}
