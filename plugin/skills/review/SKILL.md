---
name: review
description: 复盘当前这场会话里有哪些卡点。只提问、不落盘。用户说「复盘一下」「这场会话我学到什么了」「review 一下」或者想沉淀刚才那轮经验时用。
user-invocable: true
allowed-tools:
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/coach.mjs review)
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/coach.mjs review *)
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/coach.mjs save *)
---

# 复盘这场会话

跑这一条:

```
node ${CLAUDE_PLUGIN_ROOT}/dist/coach.mjs review --latest
```

## 你要做的

**把命令的输出原样贴给用户。** 不要总结、不要替他挑、不要按重要性重排。
那些卡点的标题、类型、证据都是 CLI 从会话里直接抽的 —— 你复述一遍只会丢信息。

输出里已经写明了「这些还都不是知识,只是候选」。**不要越过这句话**。

## 然后只问一句

> 这几条里，哪一条是你真觉得自己学到东西的？用你自己的话说一遍它到底意味着什么。

## 三条禁令

1. **不要替他想那句话。** 不要写「你可能觉得……」「大概是说……」，不要给例句，
   不要替他填。这个工具的全部产出就是他那句话 —— 你写了，它就白做了。
2. **不要顺手落盘。** `review` 落盘要看不出痕迹地变成 `distill` —— 知识库会迅速
   被你的摘要灌满，而摘要是不会让人变强的。落盘必须由他本人开口。
3. **不要把候选说成结论。** 「发现你有 3 个坑」是错的说法，那是 3 个候选。

## 他答了之后

用**他的话逐字**存进去（这一步见 `save` skill）：

```
node ${CLAUDE_PLUGIN_ROOT}/dist/coach.mjs save --id <他挑的那条的 id> --my-words "<他的原话>"
```

如果他不满意这个挑选结果，或者想换个会话复盘，让他说清楚是哪一场，再用
`--session <id|路径>`。命令会把它认为挑中的是哪一场打印出来，先看那一行。
