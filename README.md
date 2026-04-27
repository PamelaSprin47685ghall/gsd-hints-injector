# GSD Hints Injector

`gsd-hints-injector` 是一款极简且专注的 GSD (Get Shit Done) 插件。它以轻量化的单文件纯 JavaScript 架构，优雅地处理系统提示词（System Prompt）的注入与缓存命中率优化。

本插件的职责高度内聚，专注于解决以下三个独立而正交的问题：

1. **注入全局与项目级提示词 (Inject HINTS)**：将你配置在 `~/.gsd/HINTS.md` 和项目级 `.gsd/HINTS.md` 中的系统提示词稳定、可靠地注入到 LLM 的上下文中。
2. **剥离动态上下文 (Dynamic Context Extraction)**：主动将 System Prompt 中易变的内容（如“当前时间”、“当前工作目录”等动态行）剥离出来，移动到一个隐藏的 User Message 中。这能极大提升大模型 Prompt Cache 的命中率。
3. **稳定 Payload 标识符 (Stabilize Responses Identifiers)**：拦截并稳定 OpenAI / Azure 响应负载中易变的会话级 ID，确保相同的上下文片段即使在不同会话中产生，也能生成完全一致的 Hash 以实现最大化缓存复用。

## 特性与架构哲学

- **极简原生单文件**：完全抛弃臃肿的依赖、TypeScript 编译和内部核心 API 强耦合。所有逻辑包含在一个不到 100 行的核心模块 `index.js` 中。
- **安全的事件拦截**：仅使用官方授权的 `before_agent_start` 和 `before_provider_request` 钩子，不会污染原型链，不会劫持底层执行流，哪怕 GSD 核心发生大版本变更也不会引发应用崩溃。
- **纯粹的透明处理**：不输出多余的 UI 干扰，静默地为你省下大量 Token，并精准传达你的定制化 HINTS。

## 安装

这是为 `pi-coding-agent` (GSD) 开发的非官方社区插件。假设你当前位于 GSD 配置的插件目录中：

```bash
git clone https://github.com/your-username/gsd-hints-injector.git
```

在插件目录内确保 `package.json` 包含 GSD 和 Pi 所需的配置项：

```json
{
  "gsd": {
    "extension": true
  },
  "pi": {
    "extensions": ["index.js"]
  }
}
```

启用后，插件将自动在你的每个代理执行循环中静默生效。

## 提示词来源 (HINTS Sources)

插件会在运行时依次侦测并组合以下来源的指导规则：

1. **全局提示词 (Global hints)**: `~/.gsd/HINTS.md` 或（当设定时） `${GSD_HOME}/HINTS.md`。
2. **项目级提示词 (Project hints)**: 当前工作目录中的 `.gsd/HINTS.md`（优先），如果不存在则回退至项目根目录的 `HINTS.md`。

写在这两个文件中的内容，会被打上 `[HINTS — Stable Guidance]` 的标识，以最高权重强行注入到大模型的系统认知中。

## 运行测试

只需安装 Node.js (>=20) ，即可运行零外部依赖的内建测试：

```bash
npm run test
# 或者直接运行:
# node --test index.test.mjs
```

## 证书

MIT License
