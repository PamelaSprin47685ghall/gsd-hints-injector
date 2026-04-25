import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";

export default async function registerExtension(pi: ExtensionAPI) {
  // 使用 before_agent_start Hook 确保在每一轮对话开始前进行注入。
  // 这是 GSD2 中注入上下文信息的推荐方式。
  pi.on("before_agent_start", async (_event, ctx) => {
    // 1. 解析全局 HINTS 路径 (~/.gsd/HINTS.md)
    const globalHintsPath = join(process.env.GSD_HOME || join(homedir(), ".gsd"), "HINTS.md");
    
    // 2. 解析项目级 HINTS 路径 (使用 ctx.cwd 确保在 GSD 多项目环境下路径正确)
    const projectRoot = ctx.cwd;
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

    // 如果存在提示内容，则返回注入消息
    if (hintsText) {
      return {
        message: {
          customType: "hints-injector",
          content: `**System Auto-Injected HINTS:**\n\nPlease adhere to the following hints for this session:\n\n${hintsText}`,
          display: true
        }
      };
    }
  });
}
