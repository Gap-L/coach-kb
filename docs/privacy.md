# 隐私与数据去向

> 先给结论:**默认状态下一个字节都不出本机。**
> 会外发的那条路(调用模型)必须由你亲手打开,而且随时能关。

## 默认是什么

| 项 | 默认 | 意味着 |
|---|---|---|
| 脑(brain) | `none` | 不调任何模型,只产**骨架卡**(标题 + 证据 + 空的两节) |
| hook 提醒 | 开 | 但只在**本机**读会话文件尾部,不联网 |
| 遥测 | **没有** | 本项目不含任何上报代码 |
| 网络请求 | 只有你 enable 脑之后才有 | 否则一次都没有 |

装完就默认外发是最坏的一种默认 —— 这个项目没有采用它。

## 什么叫"外发"

一旦你跑 `coach brain enable claude --yes`,从今往后的复盘会把
**裁剪过的会话片段**发给一个模型。关于那条路,三件事必须说清楚:

### 1. 它不是 Anthropic 官方

本机实测:`claude -p` 走的是配置里的**自定义 endpoint**,实际跑在
`deepseek-flash` 上。也就是说,发给"claude"的东西并不由 Anthropic 处理。

这意味着你签名的那份数据处理条款**不适用于这条路径**。
如果你对这一点有顾虑,用 `--brain none`(默认)或 `--no-llm`,功能会退化成骨架卡,
但一个字节都不会出去。

### 2. 发出去的不是整场会话

`core/excerpt.ts` 按预算裁剪,不是把 transcript 整段塞进去:

- 每场会话只取**信号命中处附近的窗口**,按候选数均分预算(默认 6000 token)
- 证据行(文件:行号 / 命令 / 报错原文)优先保留
- 整段的 `thinking` **不进提示词** —— 它体积巨大,只按需截取关键决策点前的部分

### 3. 固定开销比你以为的大

设计阶段在本机实测过一次 `printf '回答一个词:OK' | claude -p --output-format json`:

| 指标 | 实测值 |
|---|---|
| `input_tokens` | 45,204 |
| `total_cost_usd` | 0.227 |

把这 45k 拆开看:

| attachment 类型 | 字节 | 占比 |
|---|---|---|
| `prompt_snapshot`(Claude Code 自身的 systemPrompt + 全部工具 schema) | 199,892 | **90%** |
| `skill_listing`(本机技能清单) | 13,240 | 6% |
| `agent_listing_delta` / `hook_success` / `environment` / `model` / `date` | ~7,000 | 3% |

**九成固定开销是 agentic 运行时本身(系统提示 + 工具定义),不是插件和技能。**

所以"用 `--settings` 关掉技能来省钱"是白费力气。真正的杠杆只有两条:
**少调用**,和**每次调用多干活**。这就是 distill 一次处理整场会话全部候选、
要求输出 JSON 数组的原因。

> 这张表是设计阶段测的,不是每次跑都会更新。要拿当前数字:
> `coach brain bench --yes`(注意:它真的会花钱)。

## 脱敏:三层防线

会话里一定会出现密钥。本机就有一例已知的:
`~/.codex/config.toml` 的 `shell_environment_policy.set` 里**明文存着
`ANTHROPIC_AUTH_TOKEN`**(本文档不记录它的值,也不该记录)。

| 层 | 位置 | 作用 |
|---|---|---|
| **L1 ingest** | 构造中间表示时逐字段过一遍 | 主边界 |
| **L2 compose** | 拼好 prompt、spawn 之前再断言一次 | 抓 L1 的漏 |
| **L3 write** | 卡片落盘前再扫一遍 | 模型可能从上下文"重构"出密钥 |

规则(`core/redact.ts`,按顺序,先具体后宽泛):

| 规则 | 匹配 |
|---|---|
| `private_key` | `-----BEGIN … PRIVATE KEY-----` 块(整块) |
| `api_key_sk` | `sk-…` |
| `github_token` | `ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_` / `github_pat_…` |
| `aws_key` | `AKIA…` / `AKID…` / `ASIA…` |
| `slack_token` | `xoxb-` / `xoxa-` / `xoxp-` / `xoxr-` / `xoxs-` |
| `jwt` | `eyJ….….…` |
| `bearer` | `Bearer <token>` |
| `auth_header` | `Authorization` / `X-Api-Key` / `X-Auth-Token` 的值 |
| `conn_string` | `postgres://user:密码@` —— **只遮密码,保留 host/db**(诊断时要用) |
| `env_assign_secret` | `…_TOKEN=` / `_KEY=` / `_SECRET=` / `_PASSWORD=` / `_AUTH=` 的**值**(保留变量名,"这里有 AUTH_TOKEN"本身是有效信息) |
| `named_secret` | `anthropic…_api_key` / `deepseek…_token` 等厂商前缀 |
| `generic_assign` | `password=` / `secret=` / `token=` / `api_key=` 的值 |
| `high_entropy`(单独一档) | 长度 28–96、三类字符齐全、Shannon 熵 > 4.2 的串 → 标成 `«SUSPECT:high_entropy»` |

### 两条刻意的取舍

**假密钥白名单。** 含 `test` / `fake` / `dummy` / `sample` / `example` /
`placeholder` / `redacted` 等的匹配**放行**。少了这条,fixture 和示例天天被误伤。

**`high_entropy` 只标记不静默替换。** 它是唯一会误伤的一档 ——
真 commit sha、某些长路径的熵和密钥是同一量级。所以它不猜,只标出来让人看。
`looksEntropic()` 里先按形状排除:含 `/` 的当路径放过,纯 hex 的当 commit sha 放过,
缺大写/小写/数字任一类的放过(kebab-case 目录名全落这里)。

### 怎么验证它还在工作

```bash
coach doctor
```

里面那一节「脱敏抽查」跑 12 条 canary(每种密钥类型一条),断言**密钥原文消失**。
判据故意写成"原文还在不在",而不是"哪条规则命中了" —— 前者是真正要保证的性质,
规则怎么改名、谁先谁后都不影响它。

`test/doctor.test.ts` 另外钉住 canary 表本身不空转:每条 canary 必须
① 确实含有它声称的 secret,② 至少有一条**命名**规则真的命中。
第 ② 条是有用的 —— 只靠 `high_entropy` 顺手捡走的话,密钥确实消失了,
但遮罩结果是 `SUSPECT` 而不是 `REDACTED`,人读不出原本是什么变量。

## 落盘前的二次扫描

`core/kb.ts` 在写卡片前再扫一遍(`safeForCard`)。这里对两种来源**刻意不同处理**:

| 来源 | 出现密钥时 | 为什么 |
|---|---|---|
| AI 输出 | **拒绝写卡并报警** | 上游漏了,必须让人知道 |
| 你自己的话(`save --my-words`) | **就地遮罩,不拒绝** | 那是你刚打的字,拒绝等于把它扔了 |

同一个动作在两种来源下后果不同,处理就该不同。

## 本地数据都放在哪

| 路径 | 内容 | 权限 |
|---|---|---|
| `~/knowledge/` | 知识库(你自己写的 Markdown) | `0700` |
| `~/knowledge/.coach/state.json` | 幂等水位线、hook 冷却账本 | `0700` |
| `~/knowledge/.coach/config.json` | 你的开关与阈值(默认 `0600`) | `0600` |

知识库**不属于任何代码仓** —— 它记的是"你会什么",不是"这个项目怎么跑"。
项目相关的那部分知识,出口是回写进项目的 `CLAUDE.md` / `AGENTS.md`(见 `coach rule`)。

`state.json` 丢了不会坏:卡片 id 是确定性的,重跑只会得到同一批卡。
这个"丢了也能重建"的性质让它能被当成缓存,而不是数据库。

## 一键停掉一切

```bash
coach brain disable                       # 不再调模型(立即生效)
coach review --latest --no-llm            # 单次不调模型
coach install --uninstall --yes           # 卸掉插件(知识库不动)
```

或者直接编辑 `~/knowledge/.coach/config.json`:

```json
{ "hook": { "enabled": false } }
```

`hook.enabled: false` = 一次都不提醒。同一个文件里还有
`minGapSeconds`(默认 600)、`maxPerDay`(默认 6)、`cooldownSeconds`(默认 86400)。

`config.json` 和 `state.json` **故意分开**:state 是机器生成的缓存,
每次保存整份覆盖;config 是人的意图 —— 混在一起的话,任何一次状态写入
都会把手写的配置悄悄冲掉。

## 卸载后剩什么

`coach install --uninstall` 只动插件和 marketplace 注册。
**知识库不会被删** —— 那是你自己写的 Markdown。想一起清掉就自己 `rm -rf ~/knowledge`。
