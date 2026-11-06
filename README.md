# dsh-memory-budget

给 DeepSeek Harness 的"有上限长期记忆"插件。语义照搬 Hermes Agent 的 memory 工具：
**两个 Markdown 文件 + 字符预算 + 超限必须合并 + 每次会话把内容注入系统提示**。

## 它做什么

| 文件 | 存什么 | 默认上限 |
|---|---|---|
| `MEMORY.md` | 项目/环境事实：路径、命令、约定、踩过的坑 | 4000 字符 |
| `USER.md` | 用户偏好与协作方式 | 1500 字符 |

- 条目之间用 `\n§\n` 分隔，纯文本，随时能手改。
- 默认放在 `<DSH_HOME>/memories/`（`DSH_HOME` 未设时为 `%USERPROFILE%\.dsh`）。
- 每次会话把两个文件渲染成一段系统提示，带用量百分比：

  ```
  MEMORY (your personal notes) [42% — 1,680/4,000 chars]
  ══════════════════════════════════════════════
  条目一…
  §
  条目二…
  ```

## 工具

```
memory(action=add|replace|remove|list, target=memory|user,
       content=..., old_text=..., operations=[{action,content,old_text}, ...])
```

- `add`：追加一条；完全重复则不做任何事。
- `replace`：`old_text` 是子串，命中**第一条**包含它的条目，整体换成 `content`。超限时用它合并。
- `remove`：同上，删除该条。
- `operations`：批量，**按最终字符预算原子提交**，任何一步失败整批不落盘。
- 超限返回：`Memory at 3,980/4,000 chars. Adding this entry (420 chars) would reach 4,403 and exceed the limit. Consolidate now: use replace … then retry` + 当前全部条目。
- 成功返回带 `done: true` 和 "do not repeat it"，避免模型反复写同一条。

## 设计取舍（和 Hermes 的差异）

| 点 | Hermes | 本插件 |
|---|---|---|
| 提示刷新 | 启动时冻结快照，本会话内写入看不见 | 默认 `refreshOnWrite: true`：写完下一条立刻可见（代价是一次 prefix cache 失效）；设 false 即回到冻结语义 |
| 存储位置 | `hermes-home/memories` | `<DSH_HOME>/memories`，也可 `dir` 指到仓库里做版本管理 |
| 预算 | 7000 / 1500 | 4000 / 1500（可配） |
| 原子写 | 有 | 有（tmp+rename），并保留 `.bak` |
| 注入防护 | 有 threat-pattern 扫描 | 未做（DSH 的威胁模型不同，条目来源是模型自己） |

## 安装

**方式 A：作为组合包（推荐，市场安装走的就是这条路）**

在目标 profile（一般是 `~\.dsh\profiles\desktop`）的 `package.json` 里：

```json
"dependencies": { "dsh-memory-budget": "^0.1.1" },
"dsh": { "profile": { "bundles": ["...", "dsh-memory-budget"] } }
```

然后在该 profile 目录执行 `pnpm install` 并重启 DSH。包内的 `cordis.patch.yml` 会自动插入 `memory` 条目——
**不要再往 profile 的 `cordis.patch.yml` 里手写同 id 的 `- insert:` 块**，同一个 id 插两次会让组合失败。

**方式 B：本地脚本（开发用）**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

脚本把包复制到 `<profile>\node_modules\dsh-memory-budget`；若 profile 的 `dsh.profile.bundles` 已包含 `dsh-memory-budget`
就跳过 patch 追加（bundle patch 会提供那条 entry），否则在该 profile 的 `cordis.patch.yml` 末尾追加一个 `- insert:` 块。

**方式 C：手工两步**

1. 复制本目录到 `<profile>\node_modules\dsh-memory-budget`（`<profile>` 一般是 `~\.dsh\profiles\desktop`）。
2. 在 `<profile>\cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: memory
      name: dsh-memory-budget
      inject: [tools]
      config:
        memoryCharLimit: 4000
        userCharLimit: 1500
```

**重启 DSH**（宿主插件在启动时装载），新会话里应能看到 `memory` 工具，系统提示里出现"## 长期记忆"。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `dir` | `""` | 空 = `<DSH_HOME>/memories`；指到仓库目录即可 git 管理记忆 |
| `memoryCharLimit` | `4000` | MEMORY.md 预算 |
| `userCharLimit` | `1500` | USER.md 预算 |
| `promptOrder` | `120` | 提示段排序权重 |
| `refreshOnWrite` | `true` | 写入后立刻重建提示段 |

## 自测

```powershell
npm install   # 只装 devDependencies：宿主 API，用于注册测试
npm test
```

11 个用例：8 个覆盖 store（持久化与 `§` 分隔、去重、超限拒绝、replace 合并、批量原子性、`.bak`、提示块用量、双目标隔离），
3 个覆盖注册路径——`defineTool` 的 schema 是否通过 value schema DSL 编译、提示段是否安装并在写入后刷新、
`execute` 的 list 与批量分支。

注册测试用真实的 `@deepseek-ai/dsh-tools`，不是桩：schema DSL 比 JSON Schema 更严（例如 `parameters.<x>.items` 里
不允许 `required`），一旦越界 `defineTool` 会在 `ctx.tools.register` 之前抛错，插件看起来"装上了"却没有工具——
这正是这组用例要拦住的回归。

## 卸载

- 组合包方式：从 profile 的 `dsh.profile.bundles` 和 `dependencies` 里删掉 `dsh-memory-budget`，`pnpm install`，重启。
- 脚本方式：从 `cordis.patch.yml` 删掉那个 `- insert:` 块（或注释掉），删除 `node_modules\dsh-memory-budget`，重启。

`memories\` 里的文件留着不影响。

## 命名

发布名是 `dsh-memory-budget`：npm 上的 `dsh-memory` 已被他人占用，市场里的 `dsh-memory` 也已是另一个插件
（`dsh-cc-haha-memory`）。本仓库与这两个项目无关。

## 安全

dsh.so 的启发式扫描会报两处：`lib/store.js:77` 的 `fs.writeFileSync`（原子写记忆文件）和 `lib/store.js:246` 读取
`process.env`（计算默认目录）。它们各自的范围、为什么不越界、以及威胁模型都写在 [SECURITY.md](./SECURITY.md)——
插件不联网、不起子进程、只碰 `<dir>/MEMORY.md` 与 `<dir>/USER.md`（外加 `.bak` / 瞬时 `.tmp`）。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
