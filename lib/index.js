// dsh-memory-budget — bounded long-term memory for the DeepSeek Harness.
//
// Design follows Hermes Agent's memory tool:
//   - two files under <DSH_HOME>/memories (MEMORY.md for project facts,
//     USER.md for user preferences), entries separated by "\n§\n"
//   - a hard character budget per file; over-budget writes are refused and the
//     model is told to consolidate (replace/remove) rather than append
//   - the current content is injected into the system prompt, so the model
//     starts every session already knowing the durable facts
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { MemoryStore, defaultMemoryDir, memoryPromptSection } from "./store.js";

export const name = "memory";

export const Config = z.object({
  /** Directory holding MEMORY.md / USER.md. Empty = <DSH_HOME>/memories */
  dir: z.string().default(""),
  /** Character budget for MEMORY.md */
  memoryCharLimit: z.number().default(4000),
  /** Character budget for USER.md */
  userCharLimit: z.number().default(1500),
  /** Order of the prompt section relative to other sections */
  promptOrder: z.number().default(120),
  /** Re-inject the section after a successful write (costs one prefix-cache miss) */
  refreshOnWrite: z.boolean().default(true),
});

const ACTIONS = ["add", "replace", "remove", "list"];

export function apply(ctx, config = {}) {
  const store = new MemoryStore({
    dir: config.dir || defaultMemoryDir(),
    memoryCharLimit: config.memoryCharLimit ?? 4000,
    userCharLimit: config.userCharLimit ?? 1500,
  });
  // Fail fast if the directory is unreadable; a broken memory must not be silent.
  store.read("memory");
  store.read("user");

  let promptCtx = null;
  let disposeSection = null;

  const installSection = () => {
    if (!promptCtx) return;
    if (disposeSection) {
      try {
        disposeSection();
      } catch {
        /* already disposed */
      }
      disposeSection = null;
    }
    const text = memoryPromptSection(store);
    if (!text) return;
    disposeSection = promptCtx.systemPrompt.section({
      name: "memory:long-term",
      order: config.promptOrder ?? 120,
      text,
    });
  };

  ctx.inject(["systemPrompt"], (sctx) => {
    promptCtx = sctx;
    installSection();
    sctx.effect(
      () => () => {
        if (disposeSection) {
          disposeSection();
          disposeSection = null;
        }
        promptCtx = null;
      },
      "memory: prompt section",
    );
  });

  const refresh = () => {
    if (config.refreshOnWrite === false) return;
    installSection();
  };

  const tool = defineTool({
    name: "memory",
    description:
      "跨会话长期记忆。MEMORY 存项目/环境事实（路径、命令、约定、踩过的坑），USER 存用户偏好。" +
      "action=add 追加一条，replace 用 old_text 定位旧条目并整体替换（超限时用它合并），remove 删除，" +
      "list 查看当前内容。两个文件都有字符上限，写入超限会被拒绝并返回当前条目，需要先合并再重试。",
    parameters: {
      action: {
        type: "string",
        enum: ACTIONS,
        description: "add|replace|remove|list，默认 add",
      },
      target: {
        type: "string",
        enum: ["memory", "user"],
        description: "memory=项目事实（默认），user=用户偏好",
      },
      content: {
        type: "string",
        description: "add 的新条目内容；replace 时是替换后的新内容",
      },
      old_text: {
        type: "string",
        description: "replace/remove 用来定位条目的子串（命中第一条包含它的条目）",
      },
      operations: {
        type: "array",
        description: "批量操作，一次性按最终字符预算原子提交（可选，优先于单条 action）",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", enum: ["add", "replace", "remove"] },
            content: { type: "string" },
            old_text: { type: "string" },
          },
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          success: { type: "boolean" },
          done: { type: "boolean" },
          target: { type: "string" },
          message: { type: "string" },
          usage: { type: "string" },
          error: { type: "string" },
          entry_count: { type: "number" },
          entries: { type: "array", items: { type: "string" } },
          current_entries: { type: "array", items: { type: "string" } },
          note: { type: "string" },
        },
      },
      render(args, value) {
        const result = value && typeof value === "object" ? value : {};
        if (result.success === false) {
          const lines = [`memory ${args?.action ?? "?"} failed: ${result.error ?? "unknown error"}`];
          if (result.usage) lines.push(`usage: ${result.usage}`);
          if (Array.isArray(result.current_entries) && result.current_entries.length) {
            lines.push("current entries:");
            result.current_entries.forEach((entry, i) => lines.push(`${i + 1}. ${entry}`));
          }
          return [{ type: "text", text: lines.join("\n") }];
        }
        const lines = [
          `memory ${result.target ?? args?.target ?? "memory"}: ${result.message ?? "ok"}${result.usage ? ` (${result.usage})` : ""}`,
        ];
        if (Array.isArray(result.entries) && result.entries.length) {
          result.entries.forEach((entry, i) => lines.push(`${i + 1}. ${entry}`));
        }
        if (result.note) lines.push(result.note);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args = {}) {
      const target = args.target === "user" ? "user" : "memory";
      const action = String(args.action ?? "add");
      let result;
      if (Array.isArray(args.operations) && args.operations.length) {
        result = store.applyBatch(target, args.operations);
      } else if (action === "add") {
        result = store.add(target, args.content);
      } else if (action === "replace") {
        result = store.replace(target, args.old_text, args.content);
      } else if (action === "remove") {
        result = store.remove(target, args.old_text);
      } else if (action === "list") {
        result = store.status(target);
      } else {
        result = { success: false, error: `unknown action "${action}" (expected ${ACTIONS.join("|")})` };
      }
      if (result.success) refresh();
      return result;
    },
  });

  const dispose = ctx.tools.register(tool);
  if (typeof ctx.effect === "function") ctx.effect(() => () => dispose(), "memory: tool");
}

export default { name, Config, apply };
