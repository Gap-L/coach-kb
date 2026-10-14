// 知识库的读写、索引、查重。
//
// 一条贯穿始终的原则：**upsert 永不碰「我自己的表述」那一节。**
// 卡片会随着后续会话被反复更新（新证据、新的 AI 补充），但用户自己写的那句话
// 是他唯一的、不可再生的投入 —— 任何一次自动更新把它冲掉，这个工具就失去
// 存在的理由了。所以这里不用「整文件重写」，用 replaceSection 逐节替换。

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Card } from './card.ts'
import {
  SECTION_AI,
  SECTION_MINE,
  SECTION_TRANSFER,
  fileNameOf,
  hasMine,
  isThinMine,
  parseCard,
  renderCard,
  replaceSection,
} from './card.ts'
import { idFromFileName } from './ids.ts'
import { ensureKb, typeDir, type KbPaths } from './paths.ts'
import { writeRecall } from './recall.ts'
import { isoDay, isScheduledDue, nextReview, type Recall, type ReviewSchedule } from './review.ts'

export interface Located {
  card: Card
  path: string
}

export function loadCards(kb: string): Located[] {
  const p = ensureKb(kb)
  const out: Located[] = []
  for (const dir of [p.concepts, p.patterns, p.pitfalls, p.playbooks, p.inbox]) {
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue
      const path = join(dir, file)
      try {
        const card = parseCard(readFileSync(path, 'utf8'))
        if (card !== null) out.push({ card, path })
      } catch {
        /* 手改坏的卡不该让整条链崩掉 */
      }
    }
  }
  return out.sort((a, b) => b.card.source.date.localeCompare(a.card.source.date))
}

export function findCard(kb: string, id: string): Located | null {
  const p = ensureKb(kb)
  for (const dir of [p.concepts, p.patterns, p.pitfalls, p.playbooks, p.inbox]) {
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue
      if (idFromFileName(file) !== id && file !== id && !file.startsWith(id)) continue
      const path = join(dir, file)
      const card = parseCard(readFileSync(path, 'utf8'))
      if (card !== null) return { card, path }
    }
  }
  return null
}

export interface UpsertResult {
  path: string
  created: boolean
  /** 变化了才写盘；同一会话重跑时这是 false。 */
  changed: boolean
}

/**
 * 写一张卡。
 *
 * 已经存在（同 id）时**原地更新**：证据取并集、tags 取并集、AI 补充只在
 * 原来为空时填入，而 `## 我自己的表述` 一个字节都不动。
 * 于是「同一次会话跑十遍」和「跑一遍」的结果完全相同。
 */
export function upsertCard(kb: string, card: Card): UpsertResult {
  const p = ensureKb(kb)
  const existing = findCard(kb, card.id)

  if (existing === null) {
    const dir = typeDir(p, card.type)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, fileNameOf(card))
    writeFileSync(path, renderCard(card))
    return { path, created: true, changed: true }
  }

  const md = readFileSync(existing.path, 'utf8')
  const old = existing.card
  let next = md

  // 并集按**规范形**去重:渲染时反引号会被换成单引号(见 renderCard),
  // 于是一段带反引号的证据「内存里是 A、读回来是 A'」,朴素 Set 会当成两条
  // 各留一份 —— 每跑一次 distill 就多复制一条。这里用规范形做键、保留
  // 先出现的原文,旧知识库也能因此自我收敛,不需要迁移脚本。
  const canon = (s: string): string => s.replace(/`/g, "'").trim()
  const mergedEvidence = [...new Map([...old.evidence, ...card.evidence].map(e => [canon(e), e])).values()]
  if (mergedEvidence.length !== old.evidence.length) {
    next = replaceSection(next, '证据', mergedEvidence.map(e => `- \`${e.replace(/`/g, "'")}\``).join('\n'))
  }
  if (old.ai === '' && card.ai !== '') next = replaceSection(next, SECTION_AI, card.ai)
  if (old.transfer === '' && card.transfer !== '') next = replaceSection(next, SECTION_TRANSFER, card.transfer)
  // ★ 这一节永远不动。写在这里是为了让下一个人一眼看见它为什么缺席。
  void SECTION_MINE

  const changed = next !== md
  if (changed) writeFileSync(existing.path, next)
  return { path: existing.path, created: false, changed }
}

/** 把用户自己写的话填进卡片。**只做这一件事。** */
export function setMine(kb: string, id: string, words: string): { ok: boolean; message: string } {
  const found = findCard(kb, id)
  if (found === null) return { ok: false, message: `找不到卡片 ${id}` }
  const md = readFileSync(found.path, 'utf8')
  // frontmatter 的 `mine:` 要跟正文同步 —— 否则写过的卡在 frontmatter 里永远是 false,
  // 任何只读 frontmatter 的工具(Obsidian dataview 之类)都会把它当成没写过
  const body = replaceSection(md, SECTION_MINE, words.trim())
  const next = body.replace(/^mine: .*$/m, `mine: ${hasMine(body) ? 'true' : 'false'}`)
  writeFileSync(found.path, next)
  return { ok: true, message: found.path }
}

export function setStatus(kb: string, id: string, status: 'inbox' | 'confirmed'): { ok: boolean; message: string } {
  const found = findCard(kb, id)
  if (found === null) return { ok: false, message: `找不到卡片 ${id}` }

  if (status === 'confirmed') {
    // ★ 机械闸门：没写自己那句话，不许确认。
    // 旧 coach 的病根就是让「记录」变成了可选项 —— 于是永远没有记录。
    const md = readFileSync(found.path, 'utf8')
    if (!hasMine(md)) {
      return {
        ok: false,
        message:
          `${id} 还没有「我自己的表述」,不能确认。\n` +
          `先补上你自己的那句话:\n` +
          `  coach save --id ${id} --my-words "你自己的话"\n` +
          `(确实只是想先收着,加 --force)`,
      }
    }
  }

  const md = readFileSync(found.path, 'utf8')
  const next = md.replace(/^status: .*$/m, `status: ${status}`)
  if (next === md) return { ok: false, message: '改不动 status,文件格式可能被手改过' }
  writeFileSync(found.path, next)
  return { ok: true, message: `${id} → ${status}` }
}

/**
 * 替换 frontmatter 里的 `key: ...` 那一行；**没有这行就插在锚点行之后**。
 *
 * 为什么需要回退分支：`newCard` 造的卡一定有 `review_count` 行，但
 * `review_last`/`review_next` 在没排过期之前根本不存在，而手写的、或者
 * 更早版本落下的卡连 `review_count` 都可能没有。缺行时直接 `replace` 会
 * **静默什么都不做** —— 命令报成功、字段没写进去。
 * 锚点也没了就原样返回，让调用方的回读校验去报错。
 */
function setFmLine(md: string, key: string, value: string, anchor: string): string {
  const re = new RegExp(`^${key}: .*$`, 'm')
  if (re.test(md)) return md.replace(re, `${key}: ${value}`)
  const a = new RegExp(`^${anchor}: .*$`, 'm').exec(md)
  if (a === null) return md
  const at = a.index + a[0].length
  return md.slice(0, at) + `\n${key}: ${value}` + md.slice(at)
}

function reviewLine(id: string, grade: Recall, s: ReviewSchedule): string {
  const word = grade === 'solid' ? '稳了' : grade === 'fuzzy' ? '模糊' : '没想起来'
  const streak =
    grade === 'solid' ? `连续 ${s.count} 次` : grade === 'fuzzy' ? `连续次数不变（${s.count}）` : '连续次数归零'
  return `${id} ${word} · 下次复习 ${s.next} · ${streak}`
}

/**
 * 记一次复习 —— 把用户自己定的那个档写进排期。
 *
 * 和 `setMine` 一样**只做这一件事**：只碰 frontmatter 里的三个 `review_*` 行，
 * 正文（尤其 `## 我自己的表述` 那节）一个字节都不动。这是这条路径上唯一的写动作。
 *
 * 闸门是 `confirmed` 而不是「到期」：没认领的卡谈不上复习，但**提前复习必须允许** ——
 * 想现在过一遍就现在过，别加「没到期不许记」。
 *
 * 不取锁：hook 根本不读卡片（见 hook/nudge.ts），这条路径没有引入新的并发写者；
 * `setMine`/`setStatus` 本来就是这个读-改-写暴露面。残余风险是同卡同时两次
 * `--reviewed` 会丢一次更新（重记一次即可），以及并发 writeIndex 让索引短暂过期
 * —— 索引总会由下一次落卡/确认/复习顺手重建，读 `kb --due` 不受影响。
 * 为从没观察到的争用加一套机器不值得。
 */
export function setReview(
  kb: string,
  id: string,
  grade: Recall,
  now = new Date(),
): { ok: boolean; message: string; review?: ReviewSchedule } {
  const found = findCard(kb, id)
  if (found === null) return { ok: false, message: `找不到卡片 ${id}` }
  if (found.card.status !== 'confirmed') {
    return {
      ok: false,
      message: `${id} 还没确认，谈不上复习。先补上你自己的那句话:\n  coach save --id ${id} --my-words "你自己的话" --confirm`,
    }
  }

  const review = nextReview(found.card.review, grade, now)
  const md = readFileSync(found.path, 'utf8')
  // 三次替换按 renderFrontmatter 的字段顺序链式锚定，
  // 于是写出来的行序和「整文件渲染一遍」的结果一致。
  let next = setFmLine(md, 'review_count', String(review.count), 'date')
  next = setFmLine(next, 'review_last', review.last, 'review_count')
  next = setFmLine(next, 'review_next', review.next, 'review_last')

  // ★ 用「读回来对不对」判成败，**不用**「字符串变没变」。
  //   setStatus 那套 `next === md → 失败` 在这里是错的：同一天连记两次「模糊」，
  //   三个值完全一样、字节完全相同，那个探测器会把一次**成功**报成「改不动」。
  const back = parseCard(next)
  if (
    back === null ||
    back.review.count !== review.count ||
    back.review.last !== review.last ||
    back.review.next !== review.next
  ) {
    return { ok: false, message: '改不动复习字段,文件格式可能被手改过' }
  }
  if (next !== md) writeFileSync(found.path, next) // 值没变就不用写盘
  return { ok: true, message: reviewLine(id, grade, review), review }
}

// ---------------------------------------------------------------------------
// 查重 —— 不引向量库
// ---------------------------------------------------------------------------

/**
 * 低成本判重：tag 交集 + 标题词 Jaccard + 证据路径重叠。
 * 只有落在临界区的才值得让 LLM 判一条（那要花 $0.23，能省则省）。
 */
export interface DupVerdict {
  verdict: 'new' | 'link' | 'merge'
  against?: string
  score: number
  reason: string
}

function titleWords(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(w => w.length >= 2),
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  return inter / (a.size + b.size - inter)
}

function pathsOf(card: Card): Set<string> {
  const out = new Set<string>()
  for (const e of card.evidence) {
    const m = e.match(/^(.+?)(?::\d+)?$/)
    if (m?.[1] !== undefined && /[/.]/.test(m[1])) out.add(m[1])
  }
  return out
}

export function judgeDuplicate(incoming: Card, existing: Card[]): DupVerdict {
  let best: { card: Card; score: number; reason: string } | null = null

  for (const other of existing) {
    if (other.id === incoming.id) continue
    const tagSim = jaccard(new Set(incoming.tags), new Set(other.tags))
    const titleSim = jaccard(titleWords(incoming.title), titleWords(other.title))
    const pathSim = jaccard(pathsOf(incoming), pathsOf(other))
    const score = 0.4 * titleSim + 0.35 * tagSim + 0.25 * pathSim
    if (best === null || score > best.score) {
      best = {
        card: other,
        score,
        reason: `标题 ${titleSim.toFixed(2)} / 标签 ${tagSim.toFixed(2)} / 证据路径 ${pathSim.toFixed(2)}`,
      }
    }
  }

  if (best === null || best.score < 0.45) {
    return { verdict: 'new', score: best?.score ?? 0, reason: '没有相近的卡' }
  }
  if (best.score >= 0.75) {
    return { verdict: 'merge', against: best.card.id, score: best.score, reason: best.reason }
  }
  return { verdict: 'link', against: best.card.id, score: best.score, reason: best.reason }
}

// ---------------------------------------------------------------------------
// 索引
// ---------------------------------------------------------------------------

export function renderIndex(cards: Card[], now = new Date()): string {
  const confirmed = cards.filter(c => c.status === 'confirmed')
  const inbox = cards.filter(c => c.status === 'inbox')
  // parseCard 已经把「没写自己那句话」的卡解析成 mine === ''，直接用。
  const noMine = cards.filter(c => c.mine === '')
  const thin = cards.filter(c => c.mine !== '' && isThinMine(renderCard(c)))

  const byTag = new Map<string, Card[]>()
  for (const c of confirmed) {
    for (const t of c.tags) {
      const list = byTag.get(t) ?? []
      list.push(c)
      byTag.set(t, list)
    }
  }

  // 只用 isScheduledDue，**不带**「落卡满 7 天」的兜底（那条只属于 `kb --due`）。
  // 兜底是一次交互命令里的提示；让这个文件在用户什么都没做时自己变响，就成了 nag。
  // 取舍写在 docs/design.md，也有测试钉着。
  const due = [...confirmed]
    .filter(c => isScheduledDue(c, now))
    .sort((a, b) => (a.review.next ?? '').localeCompare(b.review.next ?? ''))

  const line = (c: Card): string =>
    `- [${c.id}] ${c.title}　\`${c.source.date}\`${c.source.branch === undefined ? '' : ` \`${c.source.branch}\``}${
      c.links.length > 0 ? ` → ${c.links.map(l => `[[${l}]]`).join(' ')}` : ''
    }`

  return [
    '# 我的知识库',
    '',
    `> 自动生成,请勿手改。重建:\`coach index\`　最后更新 ${now.toISOString().slice(0, 19).replace('T', ' ')}`,
    '',
    `**${confirmed.length}** 张已确认 · **${inbox.length}** 张待确认${
      noMine.length > 0 ? ` · ⚠️ **${noMine.length}** 张还没写「我自己的表述」` : ''
    }${thin.length > 0 ? ` · ${thin.length} 张写得太短,建议补一句` : ''}`,
    '',
    ...(due.length > 0
      ? ['## 该复习了', '', ...due.map(line), '']
      : []),
    '## 按类型',
    '',
    ...(['pitfall', 'pattern', 'concept', 'playbook'] as const).flatMap(type => {
      const list = confirmed.filter(c => c.type === type)
      if (list.length === 0) return []
      return [`### ${type}（${list.length}）`, '', ...list.map(line), '']
    }),
    ...(byTag.size > 0
      ? ['## 按标签', '', ...[...byTag.entries()].sort().flatMap(([tag, list]) => [`- **${tag}**（${list.length}）: ${list.map(c => c.id).join(' ')}`]), '']
      : []),
    ...(inbox.length > 0
      ? [
          '## 待确认（还没有你的一句话,不进上面的索引）',
          '',
          ...inbox.map(c =>
            `- [${c.id}] ${c.title}${c.mine === '' ? '　← 缺「我自己的表述」' : isThinMine(renderCard(c)) ? '　← 写得太短' : ''}`,
          ),
          '',
        ]
      : []),
  ].join('\n')
}

/**
 * 重写总索引。
 *
 * 返回**两个**数,不是一个。原来只返回 `count`,调用方拿它去印
 * 「知识库共 N 张卡」—— 而它其实是**已确认**的数量,于是刚落了 3 张骨架卡
 * 的库会显示「共 0 张卡」。这两个数在这个项目里含义天差地别
 * (inbox = AI 写的,confirmed = 你认过的),混成一个必然误导。
 */
export function writeIndex(kb: string): { path: KbPaths['index']; total: number; confirmed: number } {
  const p = ensureKb(kb)
  const cards = loadCards(kb).map(l => l.card)
  writeFileSync(p.index, renderIndex(cards))
  // 旧卡命中表跟着索引一起重建 —— 两者同源，分开写就会出现一个更新了、另一个没更新。
  try {
    writeRecall(kb, cards)
  } catch {
    /* 检索表坏了只影响提醒，不该让 save 失败 */
  }
  return { path: p.index, total: cards.length, confirmed: cards.filter(c => c.status === 'confirmed').length }
}
