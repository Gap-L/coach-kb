# 三宿主适配:为什么不对称

> 这三个宿主的**读侧能力差得很远**,而且不是"还没做",是**结构上做不到**。
> 把这件事写清楚,比把三个都写成"支持"有用 —— 用户需要知道哪些卡片
> 是抽出来的,哪些是那个宿主自己报上来的。

## 一句话

| 宿主 | 写侧(注入协议) | 读侧(解析会话) |
|---|---|---|
| Claude Code | 复用旧 dev-mod,**本插件不注入协议**(避免双份) | ✅ 已实现 |
| Codex | `~/.codex/AGENTS.md` 的 coach 段(已有)+ `coach install --codex` 装的 skill | ✅ 已实现(`src/adapters/codex/`,`--host codex`)|
| WorkBuddy | `~/.workbuddy/rules/coach.md`(已有)+ `coach install --workbuddy` 装的 skill | ❌ **不做**。改走 `coach report` 自报 |
| Cursor | `coach install --cursor` 装进 `~/.cursor/skills/` 的 skill | ❌ **不做**。同 WorkBuddy,走 `coach report` |

> 怎么装、怎么用见 [integration.md](integration.md)。本文讲的是**为什么**这样分。

写侧是"把话递进去",读侧是"把活拿出来"。前者只需文件可写,后者需要
**有个稳定格式的文件可读** —— 差别全在这儿。

## Claude Code(已实现)

**读什么**:`~/.claude/projects/<slug>/<sessionId>.jsonl`,本机现有 230 个。
`slug` 是 cwd 把 `/` 和 `.` 换成 `-` 得到的。

> ★ **slug 是单向的,不能反解**:`/a/b` 和 `/a-b` 得到同一个 slug。
> 所以 `cwd` 一律从 jsonl 头部那几行里读,不从目录名猜(见 `core/sessions.ts`)。

**格式实测**(一场 52 MB / 18,194 行的真实会话):

| 行类型 | 行数 |
|---|---|
| `assistant` | 6,150 |
| `attachment` | 3,967 |
| `user` | 2,920 |
| `permission-mode` / `mode` / `last-prompt` / `atis-latch` | 各 975 |
| `ai-title` | 974 |
| `file-history-delta` | 147 |
| `queue-operation` | 92 |
| `system` | 39 |
| `cost-state` | 1 |

**这 2,920 行 `user` 里只有 3 行是真人输入**,其余 2,878 行是 `tool_result`。

两条结论直接定死了解析器的写法:

1. **白名单 + 未知类型计数。** 类型全集没有文档,而且会随版本加。
   `if (type === 'user')` 这种写法迟早把 `attachment` 当成对话。
   认识但故意不看的类型单列一张表(`IGNORED`),这样它们和"真·未知"
   才能分开计数 —— 后者涨了是信号,前者涨了不是。
2. **过滤 `tool_result` 是能不能读得动的分水岭**(99.9% 的噪音在这里)。

但 `tool_result` 同时**是证据的唯一来源**,而且它的形状很稳:
`Edit` 必带 `filePath`/`oldString`/`newString`/`structuredPatch`,
`Bash` 必带 `stdout`/`stderr`/`interrupted`。所以卡片「证据」一节里的
`文件:行号`、命令原文、报错首行是**直接从这里抽的,不经过模型** ——
模型也就没有机会编。

`thinking` 有 2,819 块,体积巨大,但含"为什么"的原始素材:
**只按预算截取关键决策点前的部分,绝不整段进提示词。**

## Codex(已实现)

**读什么**:`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`。
本机 15 个文件 / 40.0 MB / 5,216 行。

**信封是稳的**(实测每个文件的每一行都是这四个键):

```json
{ "timestamp": …, "ordinal": …, "type": …, "payload": { … } }
```

**但 `type` 的全集没有官方 schema,而且版本间会变。** 实测分布:

| 顶层 `type` | 行数 |
|---|---|
| `response_item` | 2,689 |
| `event_msg` | 2,088 |
| `token_usage_record` | 349 |
| `turn_context` | 52 |
| `world_state` | 19 |
| `session_meta` | 15 |
| `compacted` | 4 |

真正有内容的是 `payload.type`,而且两个父类型的取值空间完全不同:

| `response_item.payload.type` | 行数 | | `event_msg.payload.type` | 行数 |
|---|---|---|---|---|
| `function_call` | 865 | | `item_completed` | 1,388 |
| `function_call_output` | 865 | | `token_count` | 567 |
| `reasoning` | 618 | | `task_started` | 48 |
| `message` | 320 | | `task_complete` | 44 |
| `web_search_call` | 21 | | `thread_settings_applied` | 36 |

**所以 Codex 的解析器只有一条正确写法:只依赖信封 + 少数几种 payload,
其余一律计数上报,不报错。** 实现在 `src/adapters/codex/parse.ts`,只读
`response_item` 里的 `message` / `function_call(_output)` / `custom_tool_call(_output)`;
`event_msg.item_completed` 与之内容重复,不读。

两处必须做的归一化:
- **工具名**:`exec_command` / `shell` → `Bash`,`apply_patch`(不论是 heredoc 还是
  `custom_tool_call`)→ 每个文件一个 `Edit`。`signals.ts` 的规则按工具名判定,
  归一化之后一行都不用改。
- **真人输入**:user 角色里混着 `# AGENTS.md instructions`、`<environment_context>`、
  `<turn_aborted>` 这类注入,按**文本块**剥掉 —— 按整条消息判会把带图的提问整个丢掉。

成败看 `Process exited with code N`(新)或 `metadata.exit_code`(旧 shell 工具)。

> `compacted`(4 行)值得单独说:它标记上下文被压缩过,那之前的行可能
> 已经不全。Claude Code 那边有对应的 `isCompactSummary`。
> 两边都要把它当成"水位线不连续"的信号,而不是当普通行跳过。

**⚠ 不为 Codex 装 hook。** `~/.codex/config.toml` 里有 `[hooks.state]`,
信任是**按哈希钉在文件路径 + 事件 + 下标上**的:

```toml
[hooks.state."/Users/lingaibo/.codex/hooks.json:session_start:0:0"]
```

也就是说,新写进去的 hook **不会自己生效** —— 要用户手动 `/hooks` 信任一次。
一个"装好了但不生效"的坑比没有这个功能更糟。所以 `coach install --codex`
只装 skill,不装 hook。

**好消息:Codex 的 skill 形状和 Claude Code 一样** ——
`~/.codex/skills/<name>/SKILL.md`,`name`/`description` frontmatter(实测
`~/.codex/skills/diagnose/SKILL.md` 就是这个结构)。所以写侧的适配很薄。

## WorkBuddy(读侧不做)

**为什么不做** —— 三条都实测过:

| 说法 | 实测 |
|---|---|
| 会话在 `workbuddy.db` 里 | 7 张表,`sessions` **0 行**、`workspaces` 0 行、`session_usage` 0 行 |
| `~/.workbuddy/sessions/` | **空目录** |
| `local_storage/entry_*.info` | 10 字节的 `"internal"`、29 字节的 URL、一个 128 KB 的 **gzip+base64 blob** |

`~/.workbuddy` 一共 327 MB,而其中 **238 MB 是 `binaries/`**、
64 MB 是 `plugins/` —— 那是程序本体,不是会话。

结论:**会话正文没有稳定、可解析的落点**,本机上一条都没有。
为它写解析器 = 对着 Electron 的 LevelDB 猜格式,而且**猜错了不会报错**,
只会安静地解析出零条卡片 —— 正好是旧 coach `notes: 0` 那个失败模式。

**所以 WorkBuddy 走反方向**:不做读侧,让**那边自己的 AI 往
`~/knowledge/inbox/` 里写 Markdown 卡片**。这条路现在就能用,不需要
任何新代码 —— `core/kb.ts` 扫描时本来就把 `inbox/` 目录算在内,
只要卡片带 frontmatter 的 `id:` 就能被读出来(其余字段都有兜底默认值)。

代价是**这些卡片是"自报"的**。区别值得记住:

| 来源 | 证据一节是谁写的 | 可信度 |
|---|---|---|
| Claude Code / Codex 读侧 | CLI 从 `toolUseResult` 直接抽 | 模型没机会编 |
| WorkBuddy 自报 | 那个宿主的 AI 自己写 | 就是 AI 的话 |

这不是缺陷,但它意味着**卡片上的 `source.tool` 字段不是装饰**:
`unknown` 或 `workbuddy` 的卡,证据值得多看一眼再认领。

## Cursor(读侧不做)

会话在 `~/Library/Application Support/Cursor/User/**/state.vscdb`(SQLite 的 KV 表,值是内部 JSON),
格式随版本变、没有文档 —— 和 WorkBuddy 同一类问题,所以同样走 `coach report` 自报。

写侧用 skill 而不是 rules:Cursor 认 `~/.cursor/skills/<名>/SKILL.md`,和 Codex 同形,
`renderHostSkill` 直接复用;report 模板共用 WorkBuddy 那份,渲染时把 `--host` 和宿主名换成 cursor。

**不装 hook**:Cursor 的 `beforeSubmitPrompt` 只能放行/拦截,不能注入上下文。
Claude Code 里由 hook 做的「旧卡命中」,在这里由 `hosts/common/recall` skill 让那边的 AI 自己去 `kb` 查一次。

## 这个不对称对设计的三个约束

1. **不能假设证据存在。** `Evidence` 是可选丰富度,不是必然。
   新卡片的证据数组允许为空(`card.ts` 里 `(无)` 是合法值)。
2. **`source.tool` 必须准确。** 上面那张表就是理由。
3. **落盘触发永远来自确定性来源,不来自"那个宿主有没有配合"。**
   WorkBuddy 侧没有 hook 也不会丢东西 —— 它只是不走自动那条路。

## 怎么自己查这些

```bash
coach doctor
```

「宿主注入」一节会报:旧 dev-mod 在不在(含 `protocol/coach.md` 的 sha256,
漂了就说明那边动过)、`~/.codex/AGENTS.md` 的 coach 段在第几行、
`~/.workbuddy/rules/coach.md` 在不在。它**只检查注入是否还在**,
不假装能读 WorkBuddy 的会话。

> 里程碑 3 若要做 WorkBuddy 读侧,前提是那边先有了稳定格式。
> 在那之前,"支持 WorkBuddy"的诚实说法是:**写侧支持,读侧靠它自己上报。**
