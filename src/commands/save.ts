// `coach save` —— 把**你自己的那句话**放进卡片。整个项目最要紧的一条命令。
//
// 它故意很窄:只做「补上我自己的表述」这一件事,不接受任何别的野心。
// 因为这条命令的存在本身就是一份设计声明:
//
//   知识库里真正有价值的部分是 `## 我自己的表述` 那一节,不是 AI 写的那些。
//   如果哪天这条命令变得可以用,而用户不需要真的想清楚任何事,
//   这个项目就失败了 —— 它会退化成又一个「AI 帮我总结了一下」的工具。
//
// 所以这里有三道不近人情的检查:
//   1. 空话 / 占位符       → 拒绝
//   2. 太短(不到 4 个字)  → 放行,但当场说出来(用户有权写短句,但得知道自己在写短句)
//   3. 里面混了密钥        → **遮罩而不是拒绝** —— 见下面的注释

import { readFileSync } from 'node:fs'
import { hasMine, isThinMine, readSection, SECTION_MINE } from '../core/card.ts'
import { findCard, loadCards, setMine, setStatus, writeIndex } from '../core/kb.ts'
import { redactText, scanRedaction } from '../core/redact.ts'
import type { Ctx } from './ctx.ts'

/** 一眼就知道没想过的写法。全是占位符和敷衍。 */
const EMPTY_PLACEHOLDER_RE = /^(待补|暂无|没有|n\/?a|none|null|-+|\.+|…+)$/i

export async function runSave(ctx: Ctx): Promise<number> {
  const { args, out, err } = ctx

  if (args.bool('list')) return listPending(ctx)

  const id = args.get('id') ?? args.positional[0]
  if (id === undefined) {
    err('✗ 要指定卡片:coach save --id <id> --my-words "……"')
    err('  不知道 id?  coach kb --stale  或  coach save --list')
    return 2
  }

  const found = findCard(ctx.kb, id)
  if (found === null) {
    err(`✗ 找不到卡片 ${id}`)
    // 后缀匹配是常有的手误(id 中间的哈希抄一半),给个台阶
    const near = loadCards(ctx.kb)
      .filter(c => c.card.id.includes(id) || c.card.title.includes(id))
      .slice(0, 3)
    for (const n of near) err(`  你是想说 ${n.card.id}(${n.card.title})吗?`)
    return 1
  }

  const words = readWords(ctx)
  if (words === undefined) {
    err('✗ 没有拿到你说的话。用 --my-words "……"、--file <路径>,或者把话从 stdin 管道进来')
    return 2
  }

  const trimmed = words.trim()
  if (trimmed === '') {
    err('✗ 空的一句话不算数 —— 这恰恰是这条命令要拦住的东西')
    return 2
  }
  if (EMPTY_PLACEHOLDER_RE.test(trimmed)) {
    err(`✗ 「${trimmed}」是占位符,不是你的话`)
    return 2
  }

  // ---------------------------------------------------------------------
  // 密钥检查:这里**遮罩,不拒绝**。
  //
  // 和 sinkCards 里对 AI 输出的处理刚好相反,理由是把责任分清楚:
  // AI 输出里出现密钥 = 上游漏了,必须拒绝并报警;
  // 你自己的句子里出现密钥 = 你顺手粘的,拒绝就等于把你刚打的话扔了。
  // 同一个动作在两种来源下后果不同,处理就该不同。
  // ---------------------------------------------------------------------
  let body = trimmed
  const scan = scanRedaction(trimmed)
  if (!scan.ok) {
    body = redactText(trimmed).text
    err(`⚠ 你的这句话里有 ${scan.hits.length} 处疑似密钥,已就地遮罩:${scan.hits[0]}`)
    err('  (原文没有落盘。先撤掉那一段再存一次更稳妥。)')
  }

  const r = setMine(ctx.kb, found.card.id, body)
  if (!r.ok) {
    err(`✗ ${r.message}`)
    return 1
  }

  const md = readFileSync(found.path, 'utf8')
  if (!hasMine(md)) {
    // setMine 刚写完就不认,说明写进去的东西被 hasMine 判成了占位
    // (以 `>` 开头会被当成引用块占位)。宁可报错也别让用户以为存上了。
    err('✗ 写进去了,但它被判定为占位内容(整段以 > 开头会被当成引用)。换个写法再来一次。')
    return 1
  }

  // 有了他自己那句话，这张卡才进得了旧卡检索表（recall.json 跟着索引一起重建）。
  writeIndex(ctx.kb)

  out(`✓ 已存入 ${found.card.id}`)
  out(`  ${readSection(md, SECTION_MINE)}`)
  if (isThinMine(md)) {
    out('  (提示:这句话很短。短不是错,但一周后你自己可能看不懂它 —— 到时候补一句也行。)')
  }

  // --confirm 顺手把它从 inbox 提到 confirmed。
  if (args.bool('confirm') || args.bool('yes')) {
    const s = setStatus(ctx.kb, found.card.id, 'confirmed')
    if (!s.ok) {
      err(`✗ 确认失败:${s.message}`)
      return 1
    }
    writeIndex(ctx.kb)
    out('  状态 → confirmed,已进索引。')
  } else {
    out('  状态仍是 inbox。觉得稳了就跑 coach kb --confirm ' + found.card.id)
  }
  return 0
}

// ---------------------------------------------------------------------------

/** 从三个来源取用户的话。stdin 放最后,因为它是管道式的、不该被空值挡住。 */
function readWords(ctx: Ctx): string | undefined {
  const inline = ctx.args.get('my-words') ?? ctx.args.get('words') ?? ctx.args.get('m')
  if (inline !== undefined) return inline

  const file = ctx.args.get('file')
  if (file !== undefined) {
    try {
      return readFileSync(file, 'utf8')
    } catch (e) {
      ctx.err(`✗ 读不了 ${file}:${e instanceof Error ? e.message : String(e)}`)
      return undefined
    }
  }

  if (ctx.args.given('stdin')) {
    try {
      // 0 = stdin。管道里没东西时返回空串,由调用方判空。
      return readFileSync(0, 'utf8')
    } catch {
      return undefined
    }
  }
  return undefined
}

/** 列出还等着你补一句话的卡。按「躺得最久」排 —— 最该处理的排最前。 */
function listPending(ctx: Ctx): number {
  const { out } = ctx
  const pending = loadCards(ctx.kb).filter(c => !hasMine(readFileSync(c.path, 'utf8')))
  if (pending.length === 0) {
    out('没有待补的卡。要么你写得勤,要么还没落过卡 —— coach review --latest 看看。')
    return 0
  }
  out(`${pending.length} 张卡还没等到你那句话:`)
  for (const c of pending) {
    const age = c.card.source.date
    out(`  ${c.card.id}  [${c.card.type}] ${c.card.title}`)
    out(`      ${age} · ${c.card.evidence[0] ?? '(无证据)'}`)
  }
  out('')
  out('补一句:coach save --id <id> --my-words "我原来以为……,现在知道……"')
  return 0
}
