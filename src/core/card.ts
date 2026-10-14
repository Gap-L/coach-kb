// 卡片 schema、渲染、解析。
//
// 三处刻意的设计，都是为了让这种卡「是你的」而不是「AI 的」：
//
//   1. 正文**强制分四节**，第一节是「我自己的表述」，装用户原话，逐字。
//   2. 默认 `status: inbox` —— 没写自己的话就不算数，不进索引。
//   3. `mine: false` 时 `confirm` 拒绝执行（见 commands/kb.ts）。这不是技术
//      限制，是把「必须自己写一句」这件事**机械地**钉住 —— 靠提醒是靠不住的，
//      旧 coach 就是活证据（它连落盘都没做到）。
//
// frontmatter 用**扁平** YAML（不用嵌套 map）：省掉一个 yaml 依赖，往返
// 也更容易做到字节稳定。source{} 与 review{} 摊平成 tool/session/…
// 和 review_count/review_next。

import type { CardType } from './ids.ts'
import { cardId, isCardType, slugify } from './ids.ts'

export type CardStatus = 'inbox' | 'confirmed'

export interface CardSource {
  tool: string
  session: string
  cwd: string
  branch?: string
  date: string
}

export interface CardReview {
  last?: string
  count: number
  next?: string
}

export interface Card {
  id: string
  title: string
  type: CardType
  tags: string[]
  status: CardStatus
  confidence: number
  /**
   * 为什么把它挑出来（「X 被改了 27 次」这种）。**不进正文，只进 frontmatter。**
   *
   * 留它是因为它是这张卡唯一无法从别处复原的信息：证据行会告诉你「改了哪些文件」，
   * 但「改了 27 次」只存在于发现它的那一刻。一周后你回头看，
   * 这一行决定了你会不会觉得它值得读。
   */
  why: string
  /** ★ 用户自己的话。空串 = 还没写。 */
  mine: string
  /** AI 补的两件事：为什么会这样 / 可迁移到哪。 */
  ai: string
  /** 证据，直接来自会话（文件:行号 / 命令 / 报错原文）。 */
  evidence: string[]
  /** 下次这类问题的第一步。来自旧协议第四行。 */
  transfer: string
  links: string[]
  signals: string[]
  source: CardSource
  review: CardReview
  /** 落盘前脱敏命中过，值得人工看一眼。 */
  redacted?: boolean
}

// ---------------------------------------------------------------------------
// 正文分节
// ---------------------------------------------------------------------------

export const SECTION_MINE = '我自己的表述'
export const SECTION_AI = 'AI 补充与纠正'
export const SECTION_EVIDENCE = '证据'
export const SECTION_TRANSFER = '下次这类问题的第一步'

export const MINE_PLACEHOLDER =
  '> (还没写)\n>\n> 这条卡现在**还不算数** —— 它躺在 inbox 里，不会进索引，也不算你学过。\n' +
  '> 用 `/coach-kb:save --id <id> --my-words "你自己的话"` 补上。'

export function renderCard(card: Card): string {
  const fm = renderFrontmatter(card)
  const evidence =
    card.evidence.length === 0
      ? '(无)'
      : card.evidence.map(e => `- \`${e.replace(/`/g, "'")}\``).join('\n')
  const links = card.links.length === 0 ? '' : `\n\n相关：${card.links.map(l => `[[${l}]]`).join(' ')}`

  return [
    fm,
    '',
    `# ${card.title}`,
    '',
    `## ${SECTION_MINE}`,
    '',
    card.mine.trim() === '' ? MINE_PLACEHOLDER : card.mine.trim(),
    '',
    `## ${SECTION_AI}`,
    '',
    card.ai.trim() === '' ? '(待补)' : card.ai.trim(),
    '',
    `## ${SECTION_EVIDENCE}`,
    '',
    evidence,
    '',
    `## ${SECTION_TRANSFER}`,
    '',
    card.transfer.trim() === '' ? '(待补)' : card.transfer.trim(),
    links,
    '',
  ].join('\n')
}

/** 只替换某一节的内容，其余字节原样保留 —— 「我自己的表述」永不被 upsert 覆盖。 */
export function replaceSection(md: string, section: string, body: string): string {
  const marker = `## ${section}`
  const at = md.indexOf(marker)
  if (at === -1) return md.trimEnd() + `\n\n${marker}\n\n${body.trim()}\n`
  const after = at + marker.length
  // 下一节 or 结尾
  const nextAt = md.indexOf('\n## ', after)
  const end = nextAt === -1 ? md.length : nextAt + 1
  return md.slice(0, after) + `\n\n${body.trim()}\n\n` + md.slice(end).replace(/^\n+/, '')
}

export function readSection(md: string, section: string): string {
  const marker = `## ${section}`
  const at = md.indexOf(marker)
  if (at === -1) return ''
  const from = at + marker.length
  const nextAt = md.indexOf('\n## ', from)
  const body = md.slice(from, nextAt === -1 ? md.length : nextAt)
  return body.trim()
}

/**
 * 用户到底写没写。
 *
 * **只判断「是不是占位符」，不判断「写得够不够好」。** 这个区分是必须的：
 * parseCard 用它决定要不要保留用户的话，而一旦把长度门槛塞进来，
 * 用户写下的短句子（「别猜」「先读再改」）会在下一次读取时被静默抹成空 ——
 * 也就是把「你写得不够好」执行成了「你没写过」。那正是这个项目要根治的
 * 那类失败（旧 coach 的静默落盘失败）。
 *
 * 想提示「这条太短了」，用 isThinMine —— 它只影响显示，永远不删东西。
 */
export function hasMine(md: string): boolean {
  const body = readSection(md, SECTION_MINE)
  if (body === '') return false
  if (body.startsWith('>')) return false // 整节都是引用块 = 还是占位
  return body.trim().length > 0
}

/** 写了，但短得像敷衍。**仅用于提示,不参与任何删除或校验。** */
export function isThinMine(md: string): boolean {
  if (!hasMine(md)) return false
  return readSection(md, SECTION_MINE).replace(/\s/g, '').length < 4
}

// ---------------------------------------------------------------------------
// frontmatter
// ---------------------------------------------------------------------------

function quote(s: string): string {
  if (s === '') return '""'
  if (/^[\p{L}\p{N}][\p{L}\p{N}\-_.:/@]*$/u.test(s) && !/^(true|false|null|\d+)$/i.test(s)) return s
  return JSON.stringify(s)
}

function renderFrontmatter(card: Card): string {
  const lines: Array<[string, string]> = [
    ['id', card.id],
    ['title', quote(card.title)],
    ['type', card.type],
    ['status', card.status],
    ['confidence', String(card.confidence)],
    ...(card.why.trim() === '' ? [] : ([['why', quote(card.why)]] as Array<[string, string]>)),
    ['evidence_count', String(card.evidence.length)],
    ['mine', card.mine.trim() === '' ? 'false' : 'true'],
    ['tags', `[${card.tags.map(t => quote(t)).join(', ')}]`],
    ['signals', `[${card.signals.join(', ')}]`],
    ['links', `[${card.links.join(', ')}]`],
    ['tool', card.source.tool],
    ['session', card.source.session],
    ['cwd', quote(card.source.cwd)],
    ...(card.source.branch === undefined ? [] : ([['branch', card.source.branch]] as Array<[string, string]>)),
    ['date', card.source.date],
    ['review_count', String(card.review.count)],
    ...(card.review.last === undefined ? [] : ([['review_last', card.review.last]] as Array<[string, string]>)),
    ...(card.review.next === undefined ? [] : ([['review_next', card.review.next]] as Array<[string, string]>)),
    ...(card.redacted === true ? ([['redacted', 'true']] as Array<[string, string]>) : []),
  ]
  return ['---', ...lines.map(([k, v]) => `${k}: ${v}`), '---'].join('\n')
}

function unquote(s: string): string {
  const t = s.trim()
  if (t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t) as string
    } catch {
      return t.slice(1, -1)
    }
  }
  return t
}

function parseList(s: string): string[] {
  const t = s.trim()
  if (!t.startsWith('[') || !t.endsWith(']')) return []
  return t
    .slice(1, -1)
    .split(',')
    .map(one => unquote(one))
    .filter(one => one !== '')
}

/** 解析一张卡。解析不动就返回 null —— 手改坏的卡不该让整条链崩掉。 */
export function parseCard(md: string): Card | null {
  if (!md.startsWith('---\n')) return null
  const close = md.indexOf('\n---', 4)
  if (close === -1) return null
  const head = md.slice(4, close)
  const body = md.slice(close + 4)

  const fm = new Map<string, string>()
  for (const line of head.split('\n')) {
    const at = line.indexOf(':')
    if (at === -1) continue
    fm.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }

  const id = fm.get('id') ?? ''
  if (id === '') return null
  const rawType = fm.get('type') ?? 'pitfall'
  const type: CardType = isCardType(rawType) ? rawType : 'pitfall'
  const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? id

  const card: Card = {
    id,
    title: unquote(fm.get('title') ?? '') || title,
    type,
    tags: parseList(fm.get('tags') ?? '[]'),
    status: fm.get('status') === 'confirmed' ? 'confirmed' : 'inbox',
    confidence: Number(fm.get('confidence') ?? '0.5') || 0.5,
    why: unquote(fm.get('why') ?? ''),
    mine: hasMine(body) ? readSection(body, SECTION_MINE) : '',
    ai: readSection(body, SECTION_AI).replace(/^\(待补\)$/, ''),
    evidence: readSection(body, SECTION_EVIDENCE)
      .split('\n')
      .map(l => l.replace(/^-\s*`?|`$/g, '').trim())
      .filter(l => l !== '' && l !== '(无)'),
    transfer: readSection(body, SECTION_TRANSFER).replace(/^\(待补\)$/, ''),
    links: parseList(fm.get('links') ?? '[]'),
    signals: parseList(fm.get('signals') ?? '[]'),
    source: {
      tool: fm.get('tool') ?? 'unknown',
      session: fm.get('session') ?? '',
      cwd: unquote(fm.get('cwd') ?? ''),
      ...(fm.get('branch') === undefined ? {} : { branch: unquote(fm.get('branch') as string) }),
      date: fm.get('date') ?? '',
    },
    review: {
      count: Number(fm.get('review_count') ?? '0') || 0,
      ...(fm.get('review_last') === undefined ? {} : { last: unquote(fm.get('review_last') as string) }),
      ...(fm.get('review_next') === undefined ? {} : { next: unquote(fm.get('review_next') as string) }),
    },
  }
  if (fm.get('redacted') === 'true') card.redacted = true
  return card
}

/** 落盘用的文件名。id 决定身份，slug 只影响可读性。 */
export function fileNameOf(card: Card): string {
  const slug = slugify(card.title)
  return `${card.id}-${slug}.md`
}

/** 新建一张半成品卡。证据已经填好，AI 只等着补「为什么」与「可迁移到哪」。 */
export function newCard(input: {
  type: CardType
  title: string
  sessionKey: string
  turnIndex: number
  kind: string
  why: string
  evidence: string[]
  tags: string[]
  source: CardSource
  confidence: number
}): Card {
  return {
    id: cardId(input.type, input.sessionKey, input.turnIndex, input.kind),
    title: input.title,
    type: input.type,
    tags: input.tags,
    status: 'inbox',
    confidence: input.confidence,
    why: input.why,
    // 一律留空。**这是刻意的**：哪怕这一轮的信号本身就是用户说的原话，
    // 也让他自己确认一遍再落 —— 用户的原话进不进卡片，得他说了算。
    mine: '',
    ai: '',
    evidence: input.evidence,
    transfer: '',
    links: [],
    signals: [input.kind],
    source: input.source,
    review: { count: 0 },
  }
}
