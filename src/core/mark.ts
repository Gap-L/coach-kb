// 幂等地往共享文件里写自己的一段 —— 从旧 coach 的 scripts/install.mjs 移植。
//
// 出处：~/.claude/dev-mods/91878ba0-b090-4f9d-a0d8-3a36ebeb059d/coach/scripts/install.mjs
//
// 那 5 个纯函数（stamp / unstamp / renderOwn / isOurs / pickSlot）连同它们的
// 边角特判一起搬过来了，**不要「优化」掉**：
//   · stamp 对空文件的特判 —— 否则空文件会以两个换行开头
//   · glue 的三种换行分支 —— 否则重复执行会一行一行地长空白
//   · unstamp 的两步清理（\n{3,} 然后 ^\n+）—— 否则撤回后留下空行
// 这些正是「重复执行幂等」和「撤回干净」的实际承载者。
//
// 与旧版的**唯一**差别：标记串带 tag 参数。默认 tag='coach' 时生成的字符串
// 与旧版**逐字相同** —— 于是新旧两边的 --uninstall 互相认得对方，不会出现
// 「两份协议都在」。这条性质由 beginMark 里的硬编码字符串承载，
// test/mark.test.ts 拿旧版原文钉住它。想给新工具自己的段落起名，
// 传 tag='coach-kb'（rule.ts 就是这么做的），别改 'coach' 这一支。

import { existsSync } from 'node:fs'

/**
 * 起始标记。
 *
 * ★ 默认 tag 的输出必须与旧 install.mjs:37 **逐字相同**（含 `卸载:--uninstall`
 * 这个已经过时的提示语）。这不是美学问题：stamp() 靠查找自己的 BEGIN 串来决定
 * 「是替换还是追加」，少一个字符就会在 `~/.codex/AGENTS.md` 那种已有旧段落的
 * 文件里**追加出第二个 coach:begin** —— 正是风险表里那条「协议重复注入」。
 * 提示语是否过时，远不如「认得出对方的段落」重要。见 test/mark.test.ts。
 *
 * ★ 卸载提示语必须**只由 tag 决定**，不能靠调用方传参。
 *   理由就是上面那条：stamp() 得能重新算出自己上次写下的那串 BEGIN。
 *   一旦「写的时候带了提示语、找的时候没带」，它会找不到自己上一轮的段落，
 *   于是每次 apply 都在文件里多加一份 —— 正是本函数注释在防的那件事。
 *   所以这张表在模块内，所有调用点共享同一份。
 */
const UNINSTALL_HINT: Record<string, string> = {
  'coach-kb': 'coach rule uninstall --cwd <项目>',
}

export function beginMark(tag = 'coach'): string {
  if (tag === 'coach') {
    return '<!-- coach:begin —— 由 coach 维护,勿手改;卸载:--uninstall -->'
  }
  const how = UNINSTALL_HINT[tag] ?? `coach install --uninstall --tag ${tag}`
  return `<!-- ${tag}:begin —— 由 ${tag} 维护,勿手改;卸载:${how} -->`
}

export function endMark(tag = 'coach'): string {
  return `<!-- ${tag}:end -->`
}

/** 共享文件模式：把标记段插进文本（已有就替换），回答新文本与是否变了。 */
export function stamp(text: string, body: string, tag = 'coach'): { text: string; changed: boolean } {
  const BEGIN = beginMark(tag)
  const END = endMark(tag)
  const block = `${BEGIN}\n\n${body.trim()}\n\n${END}`
  const from = text.indexOf(BEGIN)
  if (from !== -1) {
    const to = text.indexOf(END, from)
    if (to !== -1) {
      const next = text.slice(0, from) + block + text.slice(to + END.length)
      return { text: next, changed: next !== text }
    }
  }
  if (text.trim() === '') return { text: block + '\n', changed: true }
  const glue = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
  return { text: text + glue + block + '\n', changed: true }
}

/**
 * 共享文件模式：把标记段整段抠掉，连同它带进来的空行。
 *
 * 接缝要重接，不能只把两半拼回去 —— stamp 插块时在前后各垫了空行，
 * 直接拼接会多留一个换行，于是「卸载后 git diff 应该是干净的」不成立。
 * 于是这里按「前文有没有内容」重算接缝的空行数，而不是事后压缩空白
 * （事后压缩分不清「原文件本来就有的空行」和「块带进来的空行」）。
 */
export function unstamp(text: string, tag = 'coach'): { text: string; changed: boolean } {
  const BEGIN = beginMark(tag)
  const END = endMark(tag)
  const from = text.indexOf(BEGIN)
  if (from === -1) return { text, changed: false }
  const to = text.indexOf(END, from)
  const after = to === -1 ? text.length : to + END.length

  const head = text.slice(0, from).replace(/\n+$/, '')
  const tail = text.slice(after).replace(/^\n+/, '')
  const next = head === '' ? tail : tail === '' ? `${head}\n` : `${head}\n\n${tail}`
  return { text: next, changed: next !== text }
}

/** 独占文件模式：整个文件的正文。开头那行标记就是「这是我的」凭据。 */
export function renderOwn(body: string, tag = 'coach'): string {
  return `${beginMark(tag)}\n\n${body.trim()}\n`
}

/** 这个文件是不是我们写的 —— 卸载时靠它决定敢不敢删。 */
export function isOurs(text: string, tag = 'coach'): boolean {
  return text.includes(beginMark(tag))
}

/**
 * 扫出文件里所有归我们的段落 tag。
 *
 * 旧脚本没有这个。doctor 需要它：一个文件里同时出现 `coach` 与
 * `coach:rule:R1` 是正常的（协议少动、规则常变），但同时出现**两个 `coach`**
 * 就说明重复注入了，得报警。
 */
export function ownedTags(text: string): string[] {
  const out: string[] = []
  const re = /<!-- ([a-zA-Z0-9:_-]+):begin /g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) out.push(m[1])
  }
  return out
}

export interface Target {
  name: string
  flag: string
  mode: 'stamp' | 'own-file'
  slots: string[]
  requires?: string
  slot?: string
}

/** 哪个文件该写。--slot 指明的直接算数，那是人确认过的。 */
export function pickSlot(target: Target, exists: (p: string) => boolean = existsSync): string | null {
  if (target.slot !== undefined) return target.slot
  if (target.requires !== undefined && !exists(target.requires)) return null
  const found = target.slots.filter(one => exists(one))
  return found[0] ?? target.slots[0] ?? null
}
