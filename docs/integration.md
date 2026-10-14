# 接入指南:Claude Code / Codex / WorkBuddy / Cursor

四个工具共用**同一个知识库**(默认 `~/knowledge`)和同一个 CLI。
差别只在「怎么把会话里的卡点拿出来」:

| 工具 | 怎么装 | 卡点从哪来 | 证据可信度 |
|---|---|---|---|
| Claude Code | 插件(marketplace) | CLI 解析 `~/.claude/projects/**/*.jsonl` | 直接抽自工具结果,模型没机会编 |
| Codex | skill 装进 `~/.codex/skills/` | CLI 解析 `~/.codex/sessions/**/rollout-*.jsonl` | 同上 |
| WorkBuddy | skill 装进 `~/.workbuddy/skills/` | 那边的 AI 整理后经 `coach report` 上报 | AI 自报,认领前多看一眼 |
| Cursor | skill 装进 `~/.cursor/skills/` | 同 WorkBuddy | 同 WorkBuddy |

为什么不对称:WorkBuddy / Cursor 的会话没有可解析的落盘文件(实测见 [hosts.md](hosts.md))。

## 0. 前置

- Node ≥ 18(三种接入都要;CLI 是单文件 bundle,只依赖 `node:*`)
- 拿到本仓库:`git clone <仓库地址> ~/tools/coach-kb`

下文 `coach` 指 `node ~/tools/coach-kb/bin/coach.mjs`。可以起个别名:

```bash
alias coach="node ~/tools/coach-kb/bin/coach.mjs"
```

仓库里已经带了构建好的 `plugin/dist/`,**不需要 Bun**。只有改代码才要 `bun run build`。

## 1. Claude Code

```bash
claude plugin marketplace add <仓库地址>     # 或本地路径 ~/tools/coach-kb
claude plugin install coach-kb
```

只想试一下、不改全局配置:`claude --plugin-dir ~/tools/coach-kb/plugin`。

新开会话后可用:`/coach-kb:review`、`/coach-kb:save`、`/coach-kb:kb`、`/coach-kb:due`。
插件还带一个 `UserPromptSubmit` hook,在合适的时机轻提醒复盘(频率可在 `~/knowledge/.coach/config.json` 调)。

卸载:`coach install --uninstall --yes`

## 2. Codex

```bash
coach install --codex          # 预演:列出会写哪些文件
coach install --codex --yes    # 真装
```

会装 4 个 skill 到 `~/.codex/skills/`:

| skill | 作用 |
|---|---|
| `coach-kb-review` | 复盘当前项目最近一场 Codex 会话(`coach review --host codex`) |
| `coach-kb-save` | 用你自己的话认领一张卡 |
| `coach-kb-kb` | 查知识库 |
| `coach-kb-due` | 今天该复习的卡；复习完记下你自己定的档位（稳了 / 模糊 / 没想起来），据此排下次 |

在 Codex 里说「复盘一下」,或点名 `coach-kb-review` 即可。命令行也能直接用:

```bash
coach review  --host codex --latest          # 当前目录最近一场
coach review  --host codex --session 01a0d14d
coach distill --host codex --latest --no-llm # 落骨架卡
coach kb --due                               # 今天该复习的
coach kb --reviewed <id> --recall 稳了        # 记一次复习并排下次(模糊 / 没想起来)
```

`--session` 给的是 `rollout-*.jsonl` 路径时,不写 `--host` 也会自动认成 Codex。

**刻意不做的事**
- **不装 hook。** Codex 的 hook 要用户手动 `/hooks` 信任一次才生效,装了也是「看着装好了、实际不跑」。
- **不碰 `~/.codex/AGENTS.md`。** 那里的 coach 段属于旧的提问层,沉淀层不接管。

卸载:`coach install --codex --uninstall --yes`(只删带 `.coach-kb` 标记的目录,别人的 skill 不碰)

## 3. WorkBuddy

```bash
coach install --workbuddy --yes
```

装到 `~/.workbuddy/skills/`:`coach-kb-report`、`coach-kb-coach`、`coach-kb-recall`、`coach-kb-save`、`coach-kb-kb`、`coach-kb-due`。

流程跟另外两个不同,因为 CLI 读不到 WorkBuddy 的会话:

1. 你说「复盘一下」→ `coach-kb-report` 让那边的 AI 回看对话,列出候选卡点,**先问你**要记哪几条
2. 你挑完 → 它把那几条整理成 JSON,交给 `coach report` 落盘(id、格式、密钥扫描都由 CLI 负责)
3. 卡片是 `status: inbox`、`tool: workbuddy`,「我自己的表述」为空 → 你用自己的话认领

`coach report` 也能单独用(任何工具都行):

```bash
coach report --host workbuddy --cwd "$PWD" <<'EOF'
[{ "title": "tsconfig 的 paths 没生效", "type": "pitfall",
   "why": "改了三次别名才发现", "evidence": ["tsconfig.json:5"],
   "ai": "paths 需要配合 baseUrl", "transfer": "先看 baseUrl", "tags": ["typescript"] }]
EOF
```

`type` 取 `pitfall` / `playbook` / `pattern` / `concept`;同一条重复上报会合并到同一张卡上。

卸载:`coach install --workbuddy --uninstall --yes`

## 3.5 Cursor

```bash
git clone <仓库地址> ~/tools/coach-kb
node ~/tools/coach-kb/bin/coach.mjs install --cursor --yes
```

就这一条。装到 `~/.cursor/skills/`,全局生效,所有项目都能用;不需要 Bun、不改 Cursor 设置。
**新开一个 Agent 会话**后直接说话即可:

| 你说 | 触发 |
|---|---|
| 「没懂」「为什么会这样」 | `coach-kb-coach`:一次一个问题地追问,直到你自己讲清楚 |
| 「复盘一下」「记下来」 | `coach-kb-report`:列候选 → 你挑 → 上报 → 用你的话认领 |
| 「又遇到 X 了」 | `coach-kb-recall`:查到记过的卡,先让你凭记忆复述再对照 |
| 「复习一下」 | `coach-kb-due` |

和 Claude Code 的差别:**没有 hook**。Cursor 的提交前 hook 不能往上下文里注入文字,
所以报错复现 / 纠正 / 旧卡命中这几条自动提醒,改由 skill 的 description 让 Cursor 的 AI 自己判断何时用。
卡片来源记为 `tool: cursor`。

Agent 第一次跑 `node …/coach.mjs` 会要你确认,点「始终允许」后就不再问。

卸载:`node ~/tools/coach-kb/bin/coach.mjs install --cursor --uninstall --yes`

## 4. 装完检查

```bash
coach doctor
```

「宿主注入」一节会列出三边的状态。最常见的坏法是**仓库挪了位置**:Codex / WorkBuddy / Cursor 的
skill 里写的是 `coach.mjs` 的绝对路径,doctor 会报「指向的 … 不存在了」,
在新位置重跑一次 `coach install --codex --yes` / `--workbuddy --yes` 即可。

更新仓库(`git pull`)后同理:重跑一次 install,skill 内容会刷新(没变的显示 `(没变)`)。

## 5. 隐私

- 三边默认都是 `brain none`:不调模型,数据不出本机。
- `coach brain enable …` 之后,`review --save` / `distill` 会把会话摘录发给你配置的端点。
- WorkBuddy 自报的卡,内容本来就出自那边的模型,不受 `brain` 设置影响。

细节见 [privacy.md](privacy.md)。

## 6. 加一个新宿主

1. 有稳定的会话文件 → 写 `src/adapters/<host>/parse.ts`,产出 `core/model.ts` 的 `Session`;
   工具名归一化成 `Bash` / `Edit` / `Write`,`signals.ts` 的规则就能原样复用(Codex 就是这么接的)
2. 没有 → 走 `coach report` 自报,只需要一个 skill 模板放到 `plugin/hosts/<host>/`
3. 在 `core/hostskills.ts` 的 `skillPlan` / `skillsRoot` 里登记,`install` 和 `doctor` 自动认
