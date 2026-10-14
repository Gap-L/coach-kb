// 把一场会话裁到 token 预算里,但不许裁掉证据。
//
// 背景(实测):一次 `claude -p` 的固定开销是 $0.23 / 45k input tokens,而其中
// 90% 是 agentic 运行时自己的系统提示与工具 schema —— 砍不掉。所以「省 token」
// 在这个项目里的真实含义只有一个:**别把会话原文整个塞进去**。
// 52 MB 的会话里,真正值钱的只有几十行:报错原文、被改的文件与行号、
// 用户当时说的那句话。其余是 Read 的返回值、ls 的输出、思考过程。
//
// 于是这里的取舍很明确:
//   · 证据行(文件:行号 / 报错 / 用户的判断)**永不裁剪**,只做长度上限
//   · 其余按「离卡点越近越值钱」排序,裁到预算为止
//   · 裁剪**必须显式留痕**(`…(省略 N 行)`),否则 AI 会把残缺的上下文当成全部,
//     编出一个看似合理但错的因果解释 —— 那是这个工具最坏的一种失败。

import type { Evidence, Session, Turn } from './model.ts'

/** 粗略的 token 估计:中英混排取 2.5 字节/token。宁可高估,不要超预算。 */
export function estimateTokens(text: string): number {
  if (text === '') return 0
  const cjk = (text.match(/[一-鿿　-〿＀-￯]/g) ?? []).length
  const rest = text.length - cjk
  return Math.ceil(cjk / 1.5 + rest / 3.5)
}

function clipLine(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : one.slice(0, max - 1) + '…'
}

export interface ExcerptOptions {
  /** 预算,token。默认 6000 —— 加固定开销后落在一万上下。 */
  budget?: number
  /** 单个证据串的字符上限。 */
  maxEvidenceChars?: number
  /** 每个证据最多带几行原文。 */
  maxEvidenceLines?: number
}

export interface Excerpt {
  text: string
  tokens: number
  truncated: boolean
  /** 被裁掉的东西,给 digest 报告用。 */
  omittedTurns: number
}

/**
 * 给一个**窗口内的回合**做证据摘要。
 * `center` 是卡点所在的回合下标 —— 离它越近的回合保留得越完整。
 */
export function excerptTurns(turns: Turn[], center: number, opts: ExcerptOptions = {}): Excerpt {
  const budget = opts.budget ?? 6000
  const maxEv = opts.maxEvidenceChars ?? 300
  const maxEvLines = opts.maxEvidenceLines ?? 12

  // 按「离中心点的距离」排,但证据永远优先于叙述 —— 两轮排序:先分层,层内按距离。
  interface Item {
    text: string
    tier: 0 | 1 | 2 // 0=证据 1=人说的话 2=其余叙述
    dist: number
    index: number
  }
  const items: Item[] = []

  turns.forEach((t, i) => {
    const dist = Math.abs(i - center)

    for (const tc of t.toolCalls) {
      for (const e of tc.result?.evidence ?? []) {
        items.push({ text: `  ${evidenceLine(e, maxEv)}`, tier: 0, dist, index: i })
      }
      if (tc.result !== null && !tc.result.ok && tc.result.errorHead !== undefined) {
        items.push({ text: `  ✗ ${tc.name}: ${clipLine(tc.result.errorHead, maxEv)}`, tier: 0, dist, index: i })
      }
    }

    if (t.role === 'human' && t.text !== '') {
      // ★ 用户的原话是卡片的「我自己的表述」的来源,优先级仅次于证据。
      items.push({ text: `[${i}] 我: ${clipLine(t.text, 400)}`, tier: 1, dist, index: i })
    }
  })

  // 叙述层:只在预算还剩很多时才补,且只补中心附近的。
  const narrBudget = Math.floor(budget * 0.25)
  let narrUsed = 0
  turns.forEach((t, i) => {
    if (t.role !== 'assistant' || t.text === '') return
    const dist = Math.abs(i - center)
    if (dist > 3) return
    const cost = estimateTokens(t.text)
    if (narrUsed + cost > narrBudget) return
    narrUsed += cost
    items.push({ text: `[${i}] AI: ${clipLine(t.text, 300)}`, tier: 2, dist, index: i })
  })

  items.sort((a, b) => a.tier - b.tier || a.dist - b.dist || a.index - b.index)

  const out: string[] = []
  const seen = new Set<string>()
  let used = 0
  let omitted = 0

  for (const it of items) {
    if (seen.has(it.text)) continue
    const cost = estimateTokens(it.text) + 1
    if (used + cost > budget) {
      omitted += 1
      continue
    }
    seen.add(it.text)
    used += cost
    out.push(it.text)
  }

  // ★ 裁剪必须**留痕**，这是这个函数契约的一部分，不是装饰。
  //   不留的话 AI 会把残缺的上下文当成全部，编出一个看似合理但错的因果解释 ——
  //   那是这个工具最坏的一种失败：卡片看着很有道理，而「为什么」是编的。
  //   （`truncated`/`omittedTurns` 这两个返回值只够给我们自己看；真正需要
  //   知道「这里被裁过」的是**读这段文字的模型**，所以痕迹得写进 text 里。）
  if (omitted > 0) {
    out.push(`…(预算所限,上面省掉了 ${omitted} 行;证据行已优先保留)`)
  }

  // 证据不能整段消失 —— 一条都没有时,兜底把中心回合的工具名列出来。
  // 让 AI 面对「什么都没发生」比让它面对空上下文安全。
  if (!out.some(l => l.startsWith('  '))) {
    const t = turns[center]
    if (t !== undefined) {
      for (const tc of t.toolCalls.slice(0, maxEvLines)) {
        out.push(`  ${tc.name}(${clipLine(JSON.stringify(tc.input), maxEv)})`)
      }
    }
  }

  const text = out.join('\n')
  return { text, tokens: estimateTokens(text), truncated: omitted > 0, omittedTurns: omitted }
}

function evidenceLine(e: Evidence, max: number): string {
  const prefix = e.kind === 'command' ? '$' : e.kind === 'output' ? '!' : e.kind === 'patch' ? '±' : '·'
  return `${prefix} ${clipLine(e.text, max)}`
}

/**
 * 会话级别的头信息。**不包含任何对话内容** —— 只用来让 AI 知道
 * 「这是在哪个项目的哪一段」,以及给卡片 frontmatter 填 source。
 */
export function sessionHeader(s: Session): string {
  const parts = [
    `工具: ${s.host}`,
    `目录: ${s.cwd}`,
    ...(s.gitBranch === undefined ? [] : [`分支: ${s.gitBranch}`]),
    ...(s.startedAt === undefined ? [] : [`开始: ${s.startedAt}`]),
    `规模: ${s.turns.length} 回合 / ${s.turns.reduce((n, t) => n + t.toolCalls.length, 0)} 次工具调用`,
  ]
  return parts.join('\n')
}
