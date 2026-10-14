// 「旧卡命中」—— 用户在新会话里又提起一个已经沉淀过的知识点时，把他拉回那张卡。
//
// ★ 这个文件会被打进 hook.mjs，所以**只许 import node:fs / paths**。
//   不许碰 kb.ts / card.ts：那会把整个知识库模块拖进热路径（见 scripts/build.mjs）。
//
// 做法是两段式：
//   写侧（writeIndex 时）：把每张卡压成几个检索词，落一份很小的 recall.json。
//   读侧（hook 里）：只读这一份 JSON，对用户这句话做朴素子串匹配。
// 不扫卡片目录、不解析 Markdown —— 那在 <100ms 预算里放不下。
//
// 为什么是朴素匹配而不是向量：用户必须能**预测**它会命中什么（见 design.md「向量库检索」）。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { kbPaths } from './paths.ts'

export interface RecallEntry {
  id: string
  title: string
  /** 小写后的检索词：tags、证据里的文件名、标题里的长词。 */
  terms: string[]
}

/** 至少命中几个词才说话。一个词太容易撞上（「测试」「配置」）。 */
export const MIN_HITS = 2
/** 短于这个长度的词不收 —— 「ts」「js」「的」会让每句话都命中。 */
const MIN_TERM = 3

/** 这些词出现在几乎每句话里，收进来只会制造噪音。 */
const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'not', 'index', 'test', 'tests',
  'src', 'lib', 'main', 'readme', 'error', '一下', '这个', '那个', '为什么', '怎么',
])

function addTerm(set: Set<string>, raw: string): void {
  const t = raw.trim().toLowerCase()
  if (t.length < MIN_TERM && !/[一-鿿]{2,}/.test(t)) return
  if (STOP.has(t)) return
  set.add(t)
}

/** 从证据行里抠出文件名（不带目录、不带行号）。 */
function filesIn(line: string): string[] {
  const out: string[] = []
  for (const m of line.matchAll(/([\w.-]+\.[a-zA-Z]{1,6})(?::\d+)?/g)) {
    const name = m[1]
    if (name === undefined) continue
    out.push(name)
    const stem = name.replace(/\.[^.]+$/, '')
    if (stem !== name) out.push(stem)
  }
  return out
}

/** 标题切词：英文按单词，中文按连续汉字串（不做分词，靠子串匹配兜住）。 */
function titleWords(title: string): string[] {
  return title.match(/[A-Za-z_][\w-]{2,}|[一-鿿]{2,}/g) ?? []
}

export function recallEntry(card: {
  id: string
  title: string
  tags: string[]
  evidence: string[]
}): RecallEntry {
  const set = new Set<string>()
  for (const t of card.tags) addTerm(set, t)
  for (const w of titleWords(card.title)) addTerm(set, w)
  for (const line of card.evidence) for (const f of filesIn(line)) addTerm(set, f)
  return { id: card.id, title: card.title, terms: [...set] }
}

/**
 * 只收**已经有用户自己那句话**的卡。
 * 没有那句话的卡拿来复习，等于让他回忆一段 AI 摘要 —— 那不是他的知识。
 */
export function writeRecall(
  kb: string,
  cards: { id: string; title: string; tags: string[]; evidence: string[]; mine: string }[],
): void {
  const entries = cards.filter(c => c.mine !== '').map(recallEntry)
  const p = kbPaths(kb)
  mkdirSync(p.meta, { recursive: true, mode: 0o700 })
  writeFileSync(p.recall, JSON.stringify(entries))
}

export function loadRecall(kb: string): RecallEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(kbPaths(kb).recall, 'utf8'))
    return Array.isArray(parsed) ? (parsed as RecallEntry[]) : []
  } catch {
    return []
  }
}

export interface RecallHit {
  entry: RecallEntry
  hits: string[]
  score: number
}

/** 命中最多的那张；平手取先出现的。不到 MIN_HITS 返回 null。 */
export function matchRecall(prompt: string, entries: RecallEntry[], skip: Set<string>): RecallHit | null {
  const p = prompt.toLowerCase()
  let best: RecallHit | null = null
  for (const entry of entries) {
    if (skip.has(`recall:${entry.id}`)) continue
    if (!Array.isArray(entry.terms)) continue
    const hits = entry.terms.filter(t => typeof t === 'string' && p.includes(t))
    // 整个标题被原样提到，单独就够了。
    const titleHit = entry.title.length >= 4 && p.includes(entry.title.toLowerCase())
    const score = titleHit ? MIN_HITS + hits.length : hits.length
    if (score < MIN_HITS) continue
    if (best === null || score > best.score) best = { entry, hits: titleHit ? [entry.title, ...hits] : hits, score }
  }
  return best
}
