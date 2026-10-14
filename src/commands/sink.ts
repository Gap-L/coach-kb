// 候选 + 草稿 → 磁盘。`distill` 与 `save` 都走这里,保证两件事只有一份实现:
//   1. 卡片怎么拼(证据是 CLI 的,ai/transfer 是模型的,分工不许模糊)
//   2. 落盘前**必须**再扫一遍密钥
//
// 第 2 条是刻意的单点:L1 在解析时就脱过敏了,但如果某个脑把密钥**回显**在
// 它的输出里(端点报错时很常见),那唯一能拦住它的就是这里。让这条防线
// 散落在多个命令里,迟早有一个命令忘了扫。

import type { Candidate, Draft } from '../brain/types.ts'
import { type Card, newCard } from '../core/card.ts'
import { tagsOf } from '../core/candidates.ts'
import { upsertCard } from '../core/kb.ts'
import { safeForCard } from '../core/redact.ts'
import type { Session } from '../core/model.ts'

export interface Written {
  id: string
  title: string
  type: string
  path: string
  created: boolean
  changed: boolean
  hasAi: boolean
}

export interface SinkResult {
  written: Written[]
  /** 因疑似密钥被拒绝落盘的 —— 单独报,因为它意味着上游有问题。 */
  refused: string[]
}

/**
 * 证据的落盘卫生。
 *
 * IR 里的证据是**给模型看的**,越长越好 —— 它有 token 预算,能把上下文吃下去。
 * 卡片是**给人读的**,同一段证据长这样:
 *
 *     · **但它只提问、从不落盘**:`~/.claude/coach/notes/` 至今为空,状态文件…
 *       …(后面还有四百个字,还夹着一段 ```ts 代码块)
 *
 * 一条 400 字的证据会把卡片撑成一屏半,而人扫一眼卡片找的是「哪一行」。
 * 所以这里做三件事:压平换行(多行内容在 `- \`…\`` 里会直接把列表打断)、
 * 截断、去重。截断的阈值取得比较狠,因为它的作用是**指路**——
 * 想看全文有路径,点过去就是了。
 */
const EV_MAX_CHARS = 160
const EV_MAX_ITEMS = 8

export function cleanEvidence(raw: string[], max = EV_MAX_CHARS, limit = EV_MAX_ITEMS): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const one of raw) {
    // 反引号换成单引号,**在这里换一次,而不是在渲染时**。
    //
    // 渲染时换会让落盘的内容与内存里的 Card 不一致 —— 而 upsert 的
    // 证据并集是按字符串比的,于是「原串带反引号」和「读回来是单引号」
    // 被当成两条不同证据,每跑一次就多复制一条。实测踩到过:同一段
    // `~/.claude/coach/notes/` 在第 3 次 distill 后出现了 3 遍。
    // 证据是展示用的文本,在这里定成规范形,后面就再没有二义。
    const flat = one.replace(/`/g, "'").replace(/\s+/g, ' ').trim()
    if (flat === '') continue
    const cut = flat.length <= max ? flat : flat.slice(0, max - 1) + '…'
    if (seen.has(cut)) continue
    seen.add(cut)
    out.push(cut)
    if (out.length >= limit) break
  }
  return out
}

export function buildCard(cand: Candidate, draft: Partial<Draft> | undefined, session: Session): Card {
  const date = (session.startedAt ?? new Date().toISOString()).slice(0, 10)
  const card = newCard({
    type: cand.type,
    title: cand.title,
    sessionKey: `${session.host}:${session.sessionId}`,
    turnIndex: cand.turnIndex ?? 0,
    kind: cand.kind,
    why: cand.why,
    evidence: cleanEvidence(cand.evidence),
    tags: draft?.tags ?? tagsOf(cand),
    source: {
      tool: session.host,
      session: session.sessionId,
      cwd: session.cwd,
      date,
      ...(session.gitBranch === undefined ? {} : { branch: session.gitBranch }),
    },
    confidence: 0.6,
  })
  card.ai = draft?.ai ?? ''
  card.transfer = draft?.transfer ?? ''
  // 模型给的置信度优先于我们的先验 —— 它看过上下文,我们只看过计数。
  if (draft?.confidence !== undefined) card.confidence = draft.confidence
  return card
}

export function sinkCards(
  kb: string,
  session: Session,
  candidates: Candidate[],
  drafts: Partial<Draft>[],
  opts: { dryRun?: boolean; extraTags?: string[] } = {},
): SinkResult {
  const written: Written[] = []
  const refused: string[] = []

  for (const cand of candidates) {
    const draft = drafts.find(d => d.index === cand.index)
    const card = buildCard(cand, draft, session)
    if (opts.extraTags !== undefined && opts.extraTags.length > 0) {
      card.tags = [...new Set([...card.tags, ...opts.extraTags])].slice(0, 8)
    }

    // 落盘前最后一遍。命中就**拒绝写**,而不是就地遮罩 ——
    // 就地遮罩会把 `sk-ant-****` 这种东西永久留在知识库里,看着像已经处理过。
    const scan = safeForCard([card.title, card.ai, card.transfer, ...card.evidence].join('\n'))
    if (scan.masked) {
      refused.push(`${card.id} ${card.title} —— 疑似密钥,拒绝落盘`)
      continue
    }

    if (opts.dryRun === true) {
      written.push({ id: card.id, title: card.title, type: card.type, path: '(dry-run)', created: true, changed: true, hasAi: card.ai !== '' })
      continue
    }
    const r = upsertCard(kb, card)
    written.push({ id: card.id, title: card.title, type: card.type, path: r.path, created: r.created, changed: r.changed, hasAi: card.ai !== '' })
  }

  return { written, refused }
}

/** 一行式汇报。`＋` 新建、`↻` 更新、`·` 没变。 */
export function reportLines(w: Written): string {
  const mark = w.created ? '＋' : w.changed ? '↻' : '·'
  return `  ${mark} [${w.type}] ${w.title}${w.hasAi ? '' : '  (无 AI 补充)'}`
}
