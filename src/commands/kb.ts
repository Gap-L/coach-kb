// `coach kb` —— 看自己的知识库。搜、列、复习到期、找长期没认领的。
//
// 一条取舍:**不引向量库**。当卡片在几百张这个量级,标题 + tags + 证据路径
// 的朴素匹配比你预期的好用,而且它有一个向量库给不了的性质 ——
// 你**能预测**它会搜出什么。知识库的检索一旦变成"玄学命中",
// 人就不信任它,不信任就不会再打开它。
//
// 真到了几千张再上向量,那时候也才知道该怎么切分。

import { readFileSync } from 'node:fs'
import { hasMine, readSection, SECTION_AI, SECTION_MINE, SECTION_TRANSFER, type Card } from '../core/card.ts'
import { findCard, loadCards, setReview, setStatus, writeIndex, type Located } from '../core/kb.ts'
import { isDue, parseRecall } from '../core/review.ts'
import type { Ctx } from './ctx.ts'

export async function runKb(ctx: Ctx): Promise<number> {
  const { args, out, err } = ctx

  const confirmId = args.get('confirm')
  if (confirmId !== undefined) {
    const s = setStatus(ctx.kb, confirmId, 'confirmed')
    if (!s.ok) {
      err(`✗ ${s.message}`)
      return 1
    }
    writeIndex(ctx.kb)
    out(`✓ ${confirmId} → confirmed`)
    return 0
  }

  // 复习记档。放在 loadCards 之前早返回，否则会掉进下面的列表分支。
  // 用 given 而不是 get !== undefined：裸 `--reviewed` 时 get 返回 undefined，
  // 那样会静默掉进关键词搜索，打出一句莫名其妙的「没有匹配「」的卡」。
  if (args.given('reviewed')) {
    const id = args.get('reviewed')
    if (id === undefined) {
      err('✗ --reviewed 后面要跟卡片 id')
      return 2
    }
    const raw = args.get('recall')
    if (raw === undefined) {
      err('✗ 要给出复习结果：--recall 稳了 | 模糊 | 没想起来')
      return 2
    }
    const grade = parseRecall(raw)
    if (grade === null) {
      err(`✗ 不认识的 --recall「${raw}」。可用：稳了 / 模糊 / 没想起来（或 solid / fuzzy / forgot）`)
      return 2
    }
    const r = setReview(ctx.kb, id, grade)
    if (!r.ok) {
      err(`✗ ${r.message}`)
      return 1
    }
    // ★ 不写这一步，index.md 的「该复习了」就是死的。
    writeIndex(ctx.kb)
    out(`✓ ${r.message}`)
    return 0
  }

  const showId = args.get('show')
  if (showId !== undefined) return show(ctx, showId)

  const all = loadCards(ctx.kb)

  let picked: Located[]
  let banner: string

  if (args.bool('due')) {
    ;[picked, banner] = due(all)
  } else if (args.bool('stale')) {
    ;[picked, banner] = stale(all)
  } else if (args.bool('inbox')) {
    const p = all.filter(c => c.card.status === 'inbox')
    picked = p
    banner = `${p.length} 张还在 inbox`
  } else if (args.positional.length > 0 && !args.bool('list')) {
    const q = args.positional.join(' ')
    ;[picked, banner] = search(all, q)
  } else {
    picked = all
    banner = `知识库共 ${all.length} 张卡`
  }

  if (args.bool('json')) {
    out(JSON.stringify(picked.map(c => ({ ...c.card, _path: c.path })), null, 2))
    return 0
  }

  out(banner)
  if (picked.length === 0) {
    if (all.length === 0) out('(还是空的 —— coach review --latest 看看最近这场会话有什么值得沉淀的)')
    return 0
  }
  out('')
  for (const c of picked) out(format(c))
  return 0
}

// ---------------------------------------------------------------------------

function format(c: Located): string {
  const k = c.card
  const marks: string[] = []
  if (k.status === 'inbox') marks.push('待认领')
  if (!hasMine(readFileSync(c.path, 'utf8'))) marks.push('缺你自己的表述')
  const tail = marks.length === 0 ? '' : `  ← ${marks.join(' / ')}`
  return `  ${k.id}  [${k.type}] ${k.title}${tail}\n      ${k.source.date} · ${k.evidence[0] ?? '(无证据)'}`
}

function show(ctx: Ctx, id: string): number {
  const found = findCard(ctx.kb, id)
  if (found === null) {
    ctx.err(`✗ 找不到 ${id}`)
    return 1
  }
  // 直接把文件打出来 —— 卡片本来就是给人读的 Markdown,
  // 再从 Card 结构渲染一遍只会引入"显示的和文件里的不一样"这种新 bug。
  ctx.out(readFileSync(found.path, 'utf8'))
  return 0
}

/** 搜索:标题 > tags > 证据路径,三档加权。命中标题的排最前。 */
function search(all: Located[], q: string): [Located[], string] {
  const needle = q.toLowerCase()
  const scored = all
    .map(c => {
      const title = c.card.title.toLowerCase()
      const tags = c.card.tags.join(' ').toLowerCase()
      const ev = c.card.evidence.join(' ').toLowerCase()
      const body = readFileSync(c.path, 'utf8').toLowerCase()
      let score = 0
      if (title.includes(needle)) score += 10
      if (tags.includes(needle)) score += 5
      if (ev.includes(needle)) score += 3
      if (body.includes(needle)) score += 1
      return { c, score }
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)

  return [scored.map(x => x.c), scored.length === 0 ? `没有匹配「${q}」的卡` : `「${q}」命中 ${scored.length} 张`]
}

/** 到期复习。规则本身在 core/review.ts —— 这里只负责排序和那句话。 */
function due(all: Located[], now = new Date()): [Located[], string] {
  const picked = all
    .filter(c => isDue(c.card, now))
    .sort((a, b) => (a.card.review.next ?? a.card.source.date).localeCompare(b.card.review.next ?? b.card.source.date))

  return [picked, picked.length === 0 ? '今天没有到期该复习的卡' : `今天到期 ${picked.length} 张`]
}

/** 长期躺在 inbox、连自己那句话都没补的。这是本项目最该被盯住的指标。 */
function stale(all: Located[], now = new Date()): [Located[], string] {
  const picked = all
    .filter(c => {
      if (c.card.status === 'confirmed') return false
      if (hasMine(readFileSync(c.path, 'utf8'))) return false
      const born = c.card.source.date
      if (born === '') return true
      const days = (now.getTime() - new Date(born + 'T00:00:00').getTime()) / 86_400_000
      return days >= 3
    })
    .sort((a, b) => a.card.source.date.localeCompare(b.card.source.date))

  if (picked.length === 0) return [picked, '没有长期没认领的卡']
  return [
    picked,
    `${picked.length} 张卡躺了 3 天以上还没等到你那句话 —— 它们现在只是 AI 摘要,不是你的知识`,
  ]
}

/** 给 `kb show` 之外的地方复用:把卡片正文里最关键的两节摘出来。 */
export function digestOf(card: Card, path: string): string {
  const md = readFileSync(path, 'utf8')
  return [readSection(md, SECTION_MINE), readSection(md, SECTION_AI), readSection(md, SECTION_TRANSFER)]
    .filter(s => s.trim() !== '')
    .join(' / ')
}
