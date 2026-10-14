# coach-kb

教练模式的知识沉淀层：把 AI 会话里的卡点变成**你自己的**知识卡片（Markdown，默认放在 `~/knowledge`）。

支持 **Claude Code、Codex、WorkBuddy、Cursor**，共用一个知识库。完整接入说明见 [docs/integration.md](docs/integration.md)。

| 工具 | 一行装上 |
|---|---|
| Claude Code | `claude plugin marketplace add <仓库地址> && claude plugin install coach-kb` |
| Codex | `node bin/coach.mjs install --codex --yes` |
| WorkBuddy | `node bin/coach.mjs install --workbuddy --yes` |
| Cursor | `node bin/coach.mjs install --cursor --yes`（装完新开 Agent 会话，说「没懂」「复盘一下」「复习一下」即可） |

## 安装（Claude Code 插件）

```bash
claude plugin marketplace add <本仓库 git 地址>
claude plugin install coach-kb
```

装好后新开一个会话，可用：

| 命令 | 作用 |
|---|---|
| `/coach-kb:coach` | 卡点上苏格拉底式追问：一次一个问题，直到你自己讲清楚 |
| `/coach-kb:review` | 复盘本场会话的卡点（只提问，不落盘） |
| `/coach-kb:save` | 用你自己的话认领一张卡 |
| `/coach-kb:kb` | 查知识库 |
| `/coach-kb:due` | 今天该复习的卡；复习完记下你自己定的档位（稳了 / 模糊 / 没想起来），据此排下次 |

会话中还会自动提醒（每天有上限）：同一报错复现、你纠正了 AI、你说「没懂」时引你进追问；
你提到**记过的知识点**时，先让你凭记忆复述再对照卡片。关掉旧卡提醒：`.coach/config.json` 里 `hook.recall=false`。

只想先试一下、不改全局配置：

```bash
git clone <本仓库 git 地址> && cd coach-kb
claude --plugin-dir ./plugin
```

卸载：

```bash
claude plugin uninstall coach-kb
claude plugin marketplace remove coach-kb
```

## 命令行（可选）

需要 Node ≥ 18；改代码才需要 [Bun](https://bun.sh)。

```bash
node bin/coach.mjs --help
node bin/coach.mjs doctor                    # 全局自检
node bin/coach.mjs install --claude-code     # 预演安装，加 --yes 才真的动
node bin/coach.mjs install --schedule --yes  # macOS：每周一 09:00 跑 digest
node bin/coach.mjs review --host codex       # 复盘最近一场 Codex 会话
echo '{"title":"…"}' | node bin/coach.mjs report   # 自报一张卡(WorkBuddy 用)
```

## 隐私

- 默认 `--brain none`：**不调任何模型**，只产骨架卡，数据不出本机。
- `coach brain enable claude --yes` 之后，会话内容会发给你配置的模型端点。
- 知识库若要入 git，先看 [docs/privacy.md](docs/privacy.md)。

更多：[接入指南](docs/integration.md) · [设计](docs/design.md) · [各宿主支持情况](docs/hosts.md)

## 开发

```bash
bun install
bun run build      # 同时产出 dist/ 与 plugin/dist/
bun test
bun run typecheck
```

> **提交前务必 `bun run build`。** 从 git 装的插件只读得到 `plugin/dist/`，
> 它没更新，同事装到的就是旧版本。改了行为记得同步升 `plugin/.claude-plugin/plugin.json`
> 和两个 `marketplace.json` 里的 `version`。
