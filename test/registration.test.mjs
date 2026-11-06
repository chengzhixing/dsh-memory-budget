// Registration tests: apply() must survive defineTool()'s schema DSL.
//
// The schema DSL is stricter than plain JSON Schema — e.g. `required` is not
// allowed inside `parameters.<x>.items` (array element objects). When a plugin
// breaks a DSL rule, defineTool() throws *before* ctx.tools.register(), so the
// plugin loads, creates its data directory, and still exposes no tool. That is
// exactly the failure these tests are meant to catch, so they run the real
// @deepseek-ai/dsh-tools from devDependencies instead of a hand-written stub.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { apply, name as pluginName } from "../lib/index.js";

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-memory-budget-apply-"));
}

/** Minimal stand-in for the harness context: records what the plugin does. */
function fakeContext() {
  const registered = [];
  const sections = [];
  const effects = [];
  let sectionDisposals = 0;

  const ctx = {
    inject(services, callback) {
      assert.deepEqual(services, ["systemPrompt"], "memory injects only the systemPrompt service");
      callback({
        systemPrompt: {
          section(section) {
            sections.push(section);
            return () => {
              sectionDisposals += 1;
            };
          },
        },
        effect(effect, label) {
          effects.push({ effect, label });
          return () => {};
        },
      });
    },
    tools: {
      register(tool) {
        registered.push(tool);
        return () => {};
      },
    },
    effect(effect, label) {
      effects.push({ effect, label });
      return () => {};
    },
  };

  return { ctx, registered, sections, effects, sectionDisposals: () => sectionDisposals };
}

test("apply() compiles the parameter schema and registers exactly one memory tool", () => {
  const { ctx, registered, effects } = fakeContext();

  assert.equal(pluginName, "memory");
  // Throws (JsonSchemaError) if any parameters entry breaks the value schema DSL.
  apply(ctx, { dir: freshDir(), memoryCharLimit: 400, userCharLimit: 200 });

  assert.equal(registered.length, 1, "apply() must register exactly one tool");
  const tool = registered[0];
  assert.equal(tool.name, "memory");
  assert.equal(typeof tool.execute, "function");
  assert.ok(
    effects.some((entry) => entry.label === "memory: tool"),
    "the tool registration must be covered by a context effect",
  );
});

test("the prompt section starts as a header and gains content on write", async () => {
  const { ctx, registered, sections, sectionDisposals } = fakeContext();
  apply(ctx, { dir: freshDir(), memoryCharLimit: 400, userCharLimit: 200 });
  const tool = registered[0];

  assert.equal(sections.length, 1, "the section is installed on setup, even while empty");
  assert.match(sections[0].text, /^## 长期记忆/);
  assert.doesNotMatch(sections[0].text, /MEMORY \(your personal notes\)/, "no entries yet, so no block");

  const added = await tool.execute({ action: "add", content: "路径约定：D:\\shadow\\java", target: "memory" });
  assert.equal(added.success, true, JSON.stringify(added));
  assert.equal(added.entry_count, 1);
  assert.match(added.usage, /\/400 chars/);

  assert.equal(sections.length, 2, "refreshOnWrite must re-install the section");
  assert.equal(sectionDisposals(), 1, "the previous section is disposed before the new one");
  assert.equal(sections[1].name, "memory:long-term");
  assert.equal(sections[1].order, 120);
  assert.match(sections[1].text, /路径约定/);
  assert.match(sections[1].text, /MEMORY \(your personal notes\)/);
});

test("execute() supports list and the atomic operations batch", async () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { dir: freshDir(), memoryCharLimit: 400, userCharLimit: 200 });
  const tool = registered[0];

  await tool.execute({ action: "add", content: "第一条", target: "memory" });
  const listed = await tool.execute({ action: "list", target: "memory" });
  assert.equal(listed.success, true);
  assert.deepEqual(listed.entries, ["第一条"]);

  const batched = await tool.execute({
    target: "user",
    operations: [
      { action: "add", content: "偏好：先列改动清单" },
      { action: "add", content: "偏好：证据优先" },
    ],
  });
  assert.equal(batched.success, true, JSON.stringify(batched));
  assert.deepEqual((await tool.execute({ action: "list", target: "user" })).entries, [
    "偏好：先列改动清单",
    "偏好：证据优先",
  ]);
});
