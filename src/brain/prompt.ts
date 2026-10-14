// 拼提示词。三种脑子（claude / codex / http）共用同一份，保证换脑子不换行为。

import template from '../prompts/distill.md' with { type: 'text' }
import type { Candidate, DistillInput } from './types.ts'

function renderCandidates(candidates: Candidate[]): string {
  return candidates
    .map(c => {
      const lines = [`### [${c.index}] ${c.title}`, `类型: ${c.type}`, `为什么成为候选: ${c.why}`]
      if (c.evidence.length > 0) lines.push(`证据: ${c.evidence.join('、')}`)
      // 用户当时说的话：让 AI 补的「为什么」与它呼应，而不是另起一套说法。
      if (c.userWords !== undefined && c.userWords !== '') {
        lines.push(`使用者当时说: 「${c.userWords.slice(0, 300)}」`)
      }
      return lines.join('\n')
    })
    .join('\n\n')
}

export function buildPrompt(input: DistillInput): string {
  return template
    .replace('${HEADER}', input.header.trim())
    .replace('${EXCERPT}', input.excerpt.trim() || '(无)')
    .replace('${CANDIDATES}', renderCandidates(input.candidates))
}

/**
 * 把模型返回的东西对回候选表。
 *
 * **对不上的条目一律丢弃并在 notes 里记名**，不做「差不多的匹配」。
 * 错配一张卡意味着另一张卡带上别人的因果解释 —— 那比缺解释坏得多。
 */
export function reconcile(
  raw: unknown,
  candidates: Candidate[],
): { drafts: Array<{ index: number; ai: string; transfer: string; tags?: string[]; confidence?: number }>; dropped: string[] } {
  const dropped: string[] = []
  if (!Array.isArray(raw)) return { drafts: [], dropped: ['模型没有返回数组'] }

  const byIndex = new Map<number, Candidate>()
  for (const c of candidates) byIndex.set(c.index, c)

  const seen = new Set<number>()
  const drafts: Array<{ index: number; ai: string; transfer: string; tags?: string[]; confidence?: number }> = []

  for (const item of raw) {
    if (item === null || typeof item !== 'object') {
      dropped.push('不是对象的条目')
      continue
    }
    const o = item as Record<string, unknown>
    const index = typeof o['index'] === 'number' ? o['index'] : Number(o['index'])
    if (!Number.isInteger(index) || !byIndex.has(index)) {
      dropped.push(`index=${String(o['index'])} 不在候选表里`)
      continue
    }
    if (seen.has(index)) {
      dropped.push(`index=${index} 重复出现`)
      continue
    }
    seen.add(index)

    const ai = typeof o['ai'] === 'string' ? o['ai'].trim() : ''
    const transfer = typeof o['transfer'] === 'string' ? o['transfer'].trim() : ''
    const tags = Array.isArray(o['tags'])
      ? o['tags'].filter((t): t is string => typeof t === 'string' && t.trim() !== '').map(t => t.trim())
      : undefined
    const confidence =
      typeof o['confidence'] === 'number' && o['confidence'] >= 0 && o['confidence'] <= 1 ? o['confidence'] : undefined

    drafts.push({
      index,
      ai,
      transfer,
      ...(tags === undefined || tags.length === 0 ? {} : { tags: tags.slice(0, 6) }),
      ...(confidence === undefined ? {} : { confidence }),
    })
  }

  for (const c of candidates) {
    if (!seen.has(c.index)) dropped.push(`index=${c.index} 模型没给出`)
  }

  return { drafts, dropped }
}
