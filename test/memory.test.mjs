import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore, ENTRY_DELIMITER } from "../lib/store.js";

function freshStore(limits = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-memory-budget-"));
  return { dir, store: new MemoryStore({ dir, ...limits }) };
}

test("add persists entries separated by § and survives reload", () => {
  const { dir } = freshStore();
  const a = new MemoryStore({ dir });
  assert.equal(a.add("memory", "第一条：路径约定").success, true);
  assert.equal(a.add("memory", "第二条：命令约定").success, true);

  const raw = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8");
  assert.ok(raw.includes(ENTRY_DELIMITER));
  assert.equal(raw.split(ENTRY_DELIMITER).length, 2);

  const b = new MemoryStore({ dir });
  assert.deepEqual(b.read("memory"), ["第一条：路径约定", "第二条：命令约定"]);
});

test("exact duplicate add is a no-op", () => {
  const { store } = freshStore();
  store.add("memory", "same");
  const second = store.add("memory", "same");
  assert.equal(second.success, true);
  assert.match(second.message, /already exists/);
  assert.equal(store.cacheFor("memory").length, 1);
});

test("over-budget add is refused with current entries and a consolidate instruction", () => {
  const { store } = freshStore({ memoryCharLimit: 40 });
  store.add("memory", "aaaa");
  const result = store.add("memory", "b".repeat(60));
  assert.equal(result.success, false);
  assert.match(result.error, /exceed the limit/);
  assert.match(result.error, /Consolidate now/);
  assert.deepEqual(result.current_entries, ["aaaa"]);
  assert.equal(store.cacheFor("memory").length, 1);
});

test("replace merges an entry and frees budget", () => {
  const { store } = freshStore({ memoryCharLimit: 60 });
  store.add("memory", "A".repeat(30));
  store.add("memory", "B".repeat(20));
  const merged = store.replace("memory", "AAAA", "A".repeat(5));
  assert.equal(merged.success, true, JSON.stringify(merged));
  assert.equal(store.cacheFor("memory")[0], "A".repeat(5));
  assert.equal(store.add("memory", "C".repeat(20)).success, true);
});

test("replace/remove miss returns the inventory instead of guessing", () => {
  const { store } = freshStore();
  store.add("memory", "alpha");
  const miss = store.replace("memory", "nope", "x");
  assert.equal(miss.success, false);
  assert.deepEqual(miss.current_entries, ["alpha"]);
  assert.equal(store.remove("memory", "nope").success, false);
});

test("batch applies atomically against the final budget", () => {
  const { store } = freshStore({ memoryCharLimit: 80 });
  store.add("memory", "old-one");
  store.add("memory", "old-two");
  const ok = store.applyBatch("memory", [
    { action: "remove", old_text: "old-one" },
    { action: "replace", old_text: "old-two", content: "merged" },
    { action: "add", content: "new" },
  ]);
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.deepEqual(store.cacheFor("memory"), ["merged", "new"]);

  const tooBig = store.applyBatch("memory", [{ action: "add", content: "x".repeat(120) }]);
  assert.equal(tooBig.success, false);
  assert.deepEqual(store.cacheFor("memory"), ["merged", "new"], "failed batch must not write");
});

test("write keeps a .bak and the prompt block reports usage", () => {
  const { dir, store } = freshStore({ memoryCharLimit: 100 });
  store.add("memory", "first");
  store.add("memory", "second");
  assert.ok(fs.existsSync(path.join(dir, "MEMORY.md.bak")));
  const block = store.render("memory");
  assert.match(block, /MEMORY \(your personal notes\) \[\d+% — \d+\/100 chars\]/);
  assert.match(block, /first/);
});

test("user target is independent from memory", () => {
  const { store } = freshStore({ userCharLimit: 20 });
  store.add("user", "偏好：先列清单");
  assert.equal(store.cacheFor("memory").length, 0);
  assert.equal(store.cacheFor("user").length, 1);
  assert.equal(store.add("user", "x".repeat(40)).success, false);
});
