// Pure, dependency-free memory store.
// Ported semantics from Hermes Agent's tools/memory_tool.py:
//   - two Markdown files, entries separated by "\n§\n"
//   - hard character budget per file; over-budget writes are REFUSED and the
//     caller is told to consolidate (replace/remove) instead of appending
//   - exact-duplicate add is a no-op
//   - atomic write + .bak, so a crash mid-write cannot truncate the file
import fs from "node:fs";
import path from "node:path";

export const ENTRY_DELIMITER = "\n§\n";
export const TARGET_FILES = { memory: "MEMORY.md", user: "USER.md" };

export const DEFAULT_LIMITS = { memory: 4000, user: 1500 };

function nowIso() {
  return new Date().toISOString();
}

export class MemoryStore {
  constructor(options = {}) {
    const {
      dir,
      memoryCharLimit = DEFAULT_LIMITS.memory,
      userCharLimit = DEFAULT_LIMITS.user,
    } = options;
    if (!dir) throw new Error("MemoryStore requires a dir");
    this.dir = dir;
    this.limits = { memory: memoryCharLimit, user: userCharLimit };
    this.cache = { memory: null, user: null };
    fs.mkdirSync(this.dir, { recursive: true });
  }

  fileFor(target) {
    const file = TARGET_FILES[target];
    if (!file) throw new Error(`unknown target "${target}" (expected memory|user)`);
    return path.join(this.dir, file);
  }

  limitFor(target) {
    return this.limits[target] ?? DEFAULT_LIMITS.memory;
  }

  /** Read + normalize entries. Missing file = empty list. */
  read(target) {
    const file = this.fileFor(target);
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        this.cache[target] = [];
        return [];
      }
      throw error;
    }
    const entries = [];
    for (const chunk of raw.split(ENTRY_DELIMITER)) {
      const text = chunk.trim();
      if (text && !entries.includes(text)) entries.push(text);
    }
    this.cache[target] = entries;
    return entries;
  }

  /** Atomic write: tmp -> rename, previous content kept as .bak */
  write(target, entries) {
    const file = this.fileFor(target);
    const body = entries.join(ENTRY_DELIMITER) + (entries.length ? "\n" : "");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    } catch {
      /* a failed backup must not block the write */
    }
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, body, "utf8");
    fs.renameSync(tmp, file);
    this.cache[target] = entries.slice();
    return entries.length;
  }

  charCount(target) {
    const entries = this.cacheFor(target);
    return entries.join(ENTRY_DELIMITER).length;
  }

  cacheFor(target) {
    if (this.cache[target] === null) return this.read(target);
    return this.cache[target];
  }

  usage(target) {
    const chars = this.charCount(target);
    const limit = this.limitFor(target);
    const pct = limit > 0 ? Math.min(100, Math.round((chars / limit) * 100)) : 0;
    return { chars, limit, pct, text: `${pct}% — ${chars.toLocaleString("en-US")}/${limit.toLocaleString("en-US")} chars` };
  }

  status(target = "memory") {
    const u = this.usage(target);
    return {
      success: true,
      done: true,
      target,
      usage: u.text,
      entry_count: this.cacheFor(target).length,
      entries: this.cacheFor(target),
    };
  }

  /** Render the system-prompt block for a target (empty string when no entries). */
  render(target) {
    const entries = this.cacheFor(target);
    if (!entries.length) return "";
    const u = this.usage(target);
    const header =
      target === "user"
        ? `USER PROFILE (who the user is) [${u.text}]`
        : `MEMORY (your personal notes) [${u.text}]`;
    const rule = "═".repeat(46);
    return `${rule}\n${header}\n${rule}\n${entries.join(ENTRY_DELIMITER)}`;
  }

  // ---- mutations ----------------------------------------------------------

  add(target, content) {
    const text = String(content ?? "").trim();
    if (!text) return { success: false, error: "content is required for add" };
    const entries = this.cacheFor(target).slice();
    if (entries.includes(text)) {
      return { success: true, done: true, target, message: "entry already exists (no duplicate added)", usage: this.usage(target).text };
    }
    const limit = this.limitFor(target);
    const next = entries.concat(text);
    const nextChars = next.join(ENTRY_DELIMITER).length;
    if (nextChars > limit) return this.overflow(target, entries, nextChars, limit, text);
    this.write(target, next);
    return this.ok(target, "entry added");
  }

  replace(target, oldText, newContent) {
    const needle = String(oldText ?? "").trim();
    const text = String(newContent ?? "").trim();
    if (!needle) return { success: false, error: "old_text is required for replace", current_entries: this.cacheFor(target) };
    if (!text) return { success: false, error: "content (new text) is required for replace" };
    const entries = this.cacheFor(target);
    const index = entries.findIndex((entry) => entry.includes(needle));
    if (index === -1) {
      return {
        success: false,
        error: `no entry contains ${JSON.stringify(needle)}`,
        current_entries: entries,
      };
    }
    const next = entries.slice();
    next[index] = text;
    const limit = this.limitFor(target);
    const nextChars = next.join(ENTRY_DELIMITER).length;
    if (nextChars > limit) return this.overflow(target, next, nextChars, limit, text);
    this.write(target, next);
    return this.ok(target, "entry replaced");
  }

  remove(target, oldText) {
    const needle = String(oldText ?? "").trim();
    if (!needle) return { success: false, error: "old_text is required for remove", current_entries: this.cacheFor(target) };
    const entries = this.cacheFor(target);
    const index = entries.findIndex((entry) => entry.includes(needle));
    if (index === -1) {
      return { success: false, error: `no entry contains ${JSON.stringify(needle)}`, current_entries: entries };
    }
    const next = entries.slice();
    next.splice(index, 1);
    this.write(target, next);
    return this.ok(target, "entry removed");
  }

  /** Apply [{action, content, old_text}] atomically against the FINAL budget. */
  applyBatch(target, operations) {
    if (!Array.isArray(operations) || operations.length === 0) {
      return { success: false, error: "operations must be a non-empty array" };
    }
    const limit = this.limitFor(target);
    let entries = this.cacheFor(target).slice();
    for (const [i, op] of operations.entries()) {
      const action = String(op?.action ?? "").trim();
      const content = String(op?.content ?? "").trim();
      const oldText = String(op?.old_text ?? "").trim();
      if (action === "add") {
        if (!content) return { success: false, error: `operation #${i + 1}: add requires content` };
        if (!entries.includes(content)) entries.push(content);
      } else if (action === "replace") {
        if (!oldText || !content) return { success: false, error: `operation #${i + 1}: replace requires old_text and content` };
        const index = entries.findIndex((entry) => entry.includes(oldText));
        if (index === -1) return { success: false, error: `operation #${i + 1}: no entry contains ${JSON.stringify(oldText)}`, current_entries: entries };
        entries[index] = content;
      } else if (action === "remove") {
        if (!oldText) return { success: false, error: `operation #${i + 1}: remove requires old_text` };
        const index = entries.findIndex((entry) => entry.includes(oldText));
        if (index === -1) return { success: false, error: `operation #${i + 1}: no entry contains ${JSON.stringify(oldText)}`, current_entries: entries };
        entries.splice(index, 1);
      } else {
        return { success: false, error: `operation #${i + 1}: unknown action "${action}"` };
      }
    }
    const nextChars = entries.join(ENTRY_DELIMITER).length;
    if (nextChars > limit) {
      return {
        success: false,
        error: `batch result would be ${nextChars} chars, over the ${limit} limit`,
        current_entries: this.cacheFor(target),
      };
    }
    this.write(target, entries);
    return this.ok(target, `${operations.length} operation(s) applied`);
  }

  ok(target, message) {
    const u = this.usage(target);
    return {
      success: true,
      done: true,
      target,
      message,
      usage: u.text,
      entry_count: this.cacheFor(target).length,
      note: "Write saved. This update is complete — do not repeat it.",
    };
  }

  overflow(target, entries, nextChars, limit, attempted) {
    return {
      success: false,
      error:
        `Memory at ${this.usage(target).chars}/${limit} chars. Adding this entry (${attempted.length} chars) ` +
        `would reach ${nextChars} and exceed the limit. Consolidate now: use replace to merge overlapping ` +
        `entries into shorter ones, or remove stale entries (see current_entries), then retry the same call.`,
      usage: this.usage(target).text,
      current_entries: entries,
    };
  }
}

export function defaultMemoryDir(homeDir) {
  const base = homeDir || process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".dsh");
  return path.join(base, "memories");
}

export function memoryPromptSection(store) {
  const blocks = [store.render("memory"), store.render("user")].filter(Boolean);
  const head = [
    "## 长期记忆（memory 工具）",
    "你有两个跨会话保留的笔记文件，已在下文列出当前内容：",
    "- MEMORY：项目/环境事实（路径、命令、约定、踩过的坑）",
    "- USER：用户偏好与协作方式",
    "值得下次复用的事实，用 memory(action=\"add\") 立即写入；到上限会拒绝，必须先用 replace 合并或 remove 删除旧条目再重试。",
    "只记结论，不记流水账；细节写进 skill，记忆里留指针。",
  ].join("\n");
  return blocks.length ? `${head}\n\n${blocks.join("\n\n")}` : head;
}

export const _internals = { nowIso };
