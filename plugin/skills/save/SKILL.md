---
name: save
description: 把用户自己说的那句话逐字存进卡片，把它从「AI 摘要」变成「他的知识」。用户选定了某条候选、并且用自己的话说了一遍时用。
user-invocable: true
allowed-tools:
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/coach.mjs save *)
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/coach.mjs kb *)
---

# 认领一张卡

`--my-words` 里放的**必须是用户的原话**。不是你的复述、不是润色版、不是更专业的说法。
这一节（`## 我自己的表述`）是知识库里唯一 AI 写不出来的东西 —— 你替它写了，
卡片就退回成 AI 摘要，这个工具的全部意义就没了。

## 怎么把话传进去

用户的话里经常有 `"`、反引号、`$`、换行。**塞进 `--my-words "…"` 会被 shell 吃掉或执行掉。**
所以默认走带引号的 heredoc —— `<<'EOF'` 里的东西一个字符都不会被 shell 处理：

```
node ${CLAUDE_PLUGIN_ROOT}/dist/coach.mjs save --id <卡片id> --stdin <<'EOF'
这里放用户的原话，逐字，不做任何修改
EOF
```

只有在他那句话确实很短、且不含引号反引号 `$` 和换行时，才用便捷写法：

```
node ${CLAUDE_PLUGIN_ROOT}/dist/coach.mjs save --id <卡片id> --my-words "他的话"
```

## 存之前先确认一句话

- **不确定他原话是什么，就去翻对话记录。** 他可能在上一轮说过。
  逐字引用他的消息文本，不要凭印象重写。
- **他没有真的说出那句话，就不要存。** 别把「他好像有点明白了」加工成一句像样的话。
  宁可回来问一句：`你要不要自己说一遍这条到底意味着什么？说完我存。`
  他不说，这卡就留在 inbox —— **inbox 里躺着不是失败，编一句话才是。**

## 存完之后

把命令的输出贴给他（它会回显存进去的那节，以及是否太短）。然后告诉他下一步：

- 想确认这张卡 → `node ${CLAUDE_PLUGIN_ROOT}/dist/coach.mjs kb --confirm <id>`
- 还有别的卡躺着 → `node ${CLAUDE_PLUGIN_ROOT}/dist/coach.mjs save --list`

## 别做的事

- **不要 `--confirm`。** 认领和确认是两件事，让他自己跑 `kb --confirm`。
  你顺手 confirm 掉，就等于替他判断「这条稳了」。
- **不要因为他的句子短就去替他补全。** CLI 会提示「这句话很短」，
  那是给**他**看的提醒，不是给你的改写邀请。短句是他自己的东西。
- **不要把密钥抄进去。** 如果他的原话里含 token/key，CLI 会就地遮罩并警告 ——
  把那条警告原样转达，并建议他撤掉那一段再存一次。
