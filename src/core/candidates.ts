// 信号 → 候选。
//
// 分工在这里划清：**CLI 负责标题、类型、证据，AI 只负责"为什么"和"能迁移到哪"。**
// 所以这个文件里一个字的散文都不生成 —— 标题是从证据里**抠**出来的，不是编的。
// 好处有两层：省 token，以及 AI 根本没有机会编造证据（它拿到的是既成事实）。
//
// 标题的质量直接决定卡片会不会被再次打开。所以这里宁可丑一点也要具体：
// 「src/auth.ts 被改了 5 次」比「关于反复修改的思考」有用一百倍。

import type { Evidence, Signal } from './model.ts'
import type { CardType } from './ids.ts'
import type { Candidate } from '../brain/types.ts'

/** 每个信号类型对应的卡片类型。改这张表就是改知识库的组织方式。 */
const TYPE_OF: Record<string, CardType> = {
  repeat_error: 'pitfall', // 同一个报错撞了两次以上 —— 是坑
  user_correction: 'pattern', // 你纠正了我 —— 是可复用的沟通模式
  repeat_edit: 'pitfall', // 同一文件反复改 —— 动手前没想清楚
  long_debug: 'playbook', // 长排查 —— 是一套流程
  learned: 'concept', // 你自己说「原来如此」—— 是概念
  user_prediction: 'pattern', // 你动手前的判断 —— 是模式
}

/** 未知 kind 的兜底。宁可归到 concept 也不要丢 —— 丢了用户就永远看不到它。 */
export function typeOfSignal(kind: string): CardType {
  return TYPE_OF[kind] ?? 'concept'
}

/** 证据里第一条「文件」或「命令」，用来做标题的锚点。 */
function anchor(evidence: Evidence[]): string | null {
  for (const e of evidence) {
    if (e.kind === 'file' || e.kind === 'command') return e.text
  }
  return evidence[0]?.text ?? null
}

/** 去掉路径的长前缀，只留最后两段 —— 标题里不需要 `/Users/x/y/z/`。 */
function shorten(s: string): string {
  const out = s.replace(/^.*\/(?=[^/]+\/[^/]+$)/, '')
  return out.length > 48 ? out.slice(0, 47) + '…' : out
}

/**
 * 给一条信号起个标题。
 *
 * 全部来自证据或用户原话 —— 这个函数里没有一处是「总结」。总结是 AI 的活，
 * 而 AI 只能在他那一节里说话。
 */
export function titleOf(sig: Signal): string {
  const raw = (() => {
    switch (sig.kind) {
      case 'repeat_error': {
        // why 是「同一个报错出现了 N 次：<签名>」，冒号后面就是原文
        const tail = sig.why.split('：').slice(1).join('：').trim()
        return tail === '' ? (anchor(sig.evidence) ?? '反复出现的报错') : `反复踩的坑：${tail}`
      }
      case 'repeat_edit': {
        const a = anchor(sig.evidence)
        return a === null ? '同一处反复修改' : `反复改 ${shorten(a)}`
      }
      case 'long_debug': {
        const a = anchor(sig.evidence)
        return a === null ? '一段试错式排查' : `排查看 ${shorten(a)} 这段`
      }
      case 'user_correction':
        return sig.userWords === undefined || sig.userWords === ''
          ? '我纠正了 AI 的方向'
          : `我纠正过：${sig.userWords.slice(0, 30)}`
      case 'learned':
        return sig.userWords === undefined || sig.userWords === ''
          ? '我自己说的「原来如此」'
          : `想通了：${sig.userWords.slice(0, 30)}`
      case 'user_prediction':
        return sig.userWords === undefined || sig.userWords === ''
          ? '我动手前的判断'
          : `我当时的打算：${sig.userWords.slice(0, 30)}`
      default: {
        const a = anchor(sig.evidence)
        return a === null ? sig.kind : shorten(a)
      }
    }
  })()
  return raw.replace(/\s+/g, ' ').trim()
}

/**
 * 批量转换。**顺序稳定**（按 turnIndex，再按 kind）——
 * 顺序影响 candidate 的 index，而 index 会进卡片 id 的哈希输入，
 * 不稳定的排序会让同一会话两次 distill 得到不同的 id。
 */
export function toCandidates(signals: Signal[], opts: { limit?: number } = {}): Candidate[] {
  const limit = opts.limit ?? 40
  const sorted = [...signals].sort((a, b) => a.turnIndex - b.turnIndex || a.kind.localeCompare(b.kind))

  const out: Candidate[] = []
  for (const sig of sorted) {
    if (out.length >= limit) break
    const cand: Candidate = {
      index: out.length,
      title: titleOf(sig),
      type: typeOfSignal(sig.kind),
      kind: sig.kind,
      why: sig.why,
      evidence: sig.evidence.map(e => e.text),
      turnIndex: sig.turnIndex,
    }
    // 用户原话只在真的有的时候带上。空串会让提示词里多一行噪音。
    if (sig.userWords !== undefined && sig.userWords !== '') cand.userWords = sig.userWords
    out.push(cand)
  }
  return out
}

/** 从证据里抽 tags —— 文件名主干 + 报错签名关键词。纯机械，不请 AI。 */
export function tagsOf(cand: Candidate, extra: string[] = []): string[] {
  const out = new Set<string>(extra)
  for (const ev of cand.evidence) {
    // `src/auth/middleware.ts:88` → `middleware`
    const m = ev.match(/([A-Za-z0-9_-]+)\.[A-Za-z0-9]+(?::\d+)?/)
    if (m?.[1] !== undefined && m[1].length >= 3) out.add(m[1].toLowerCase())
  }
  return [...out].slice(0, 6)
}
