import { describe, expect, test } from 'bun:test'
import {
  estimateTokens,
  excerptTurns,
  sessionHeader,
  type Excerpt,
} from '../src/core/excerpt.ts'
import { emptySession, type Evidence, type Session, type ToolCall, type ToolResult, type Turn } from '../src/core/model.ts'

function ev(kind: Evidence['kind'], text: string): Evidence {
  return { kind, text }
}

function res(evidence: Evidence[], ok = true): ToolResult {
  return { ok, evidence }
}

let seq = 0
function call(name: string, input: Record<string, unknown>, result: ToolResult | null = null): ToolCall {
  seq += 1
  return { id: `c${seq}`, name, input, result }
}

/** result.ok === false 的一轮失败调用。 */
function fail(name: string, errorHead: string): ToolCall {
  return call(name, {}, { ok: false, errorSig: errorHead.split('\n')[0] ?? '', errorHead, evidence: [] })
}

function human(text: string): Turn {
  return { text, role: 'human', toolCalls: [], isSidechain: false }
}

function asst(text: string, toolCalls: ToolCall[] = []): Turn {
  return { text, role: 'assistant', toolCalls, isSidechain: false }
}

const evidenceText = (ex: Excerpt): string[] => ex.text.split('\n').filter(l => l.startsWith('  '))

describe('estimateTokens', () => {
  test('空串是 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  test('同样字数下中文比英文贵 —— 这就是「2.5 字节/token」的来源', () => {
    // 这个估计的唯一用途是把会话裁进预算，宁可高估。中英混排时按字数算会
    // 严重低估中文那一半，所以两条系数必须分开（1.5 vs 3.5 字/token）。
    expect(estimateTokens('中'.repeat(100))).toBeGreaterThan(estimateTokens('a'.repeat(100)))
  })

  test('随长度单调增', () => {
    expect(estimateTokens('abc')).toBeLessThan(estimateTokens('abc'.repeat(10)))
  })
})

describe('excerptTurns 的取舍：证据 > 人话 > 叙述', () => {
  test('★ 预算不够时先保证据 —— 证据丢了，卡片就退化成复述', () => {
    const turns = [
      asst('干活', [call('Read', { file_path: '/p/src/a.ts' }, res([ev('file', '/p/src/a.ts:1'), ev('file', '/p/src/a.ts:9'), ev('file', '/p/src/a.ts:20')]))]),
      human('我'.repeat(300)),
      human('你'.repeat(300)),
    ]
    // 预算只够三条证据（各约 6 token），人话那两行长文必然进不来
    const ex = excerptTurns(turns, 0, { budget: 30 })
    expect(ex.text).toContain('a.ts:1')
    expect(ex.text).toContain('a.ts:9')
    expect(ex.text).toContain('a.ts:20')
    expect(ex.text).not.toContain('我'.repeat(50))
  })

  test('证据在最前，人话次之，AI 的叙述最后 —— 层内离中心近的先来', () => {
    const turns = [
      human('远的人话'),
      asst('AI 的叙述文字'),
      asst('干活', [call('Read', { file_path: '/p/x.ts' }, res([ev('file', '/p/x.ts:1')]))]),
    ]
    const lines = excerptTurns(turns, 2, {}).text.split('\n')
    expect(lines[0]).toContain('x.ts:1')
    expect(lines[1]).toContain('我: 远的人话')
    expect(lines[2]).toContain('AI: 干活') // 离中心 0，排在离中心 1 的叙述前面
    expect(lines[3]).toContain('AI 的叙述文字')
  })

  test('用户的原话带回合号进来 —— 卡片「我自己的表述」要靠它回指', () => {
    const ex = excerptTurns([human(''), human('我猜是顺序问题')], 1, {})
    expect(ex.text).toContain('[1] 我: 我猜是顺序问题')
  })

  test('失败的工具有自己的一行，带 ✗ —— 报错原文是最硬的一类证据', () => {
    const ex = excerptTurns([asst('跑一下', [fail('Bash', 'error: expect(received).toBe(expected)')])], 0, {})
    expect(ex.text).toContain('✗ Bash: error: expect(received).toBe(expected)')
  })

  test('同一行证据出现两次只留一条', () => {
    const same = ev('file', '/p/src/a.ts:88')
    const turns = [
      asst('改', [call('Edit', { file_path: '/p/src/a.ts' }, res([same])), call('Edit', { file_path: '/p/src/a.ts' }, res([same]))]),
    ]
    const ex = excerptTurns(turns, 0, {})
    expect(ex.text.split('\n').filter(l => l.includes('a.ts:88')).length).toBe(1)
  })

  test('★ 一条证据都没抓到时也不给空上下文 —— 列出中心那轮调了什么工具', () => {
    // 让模型面对「什么都没发生」比让它面对空字符串安全：后者它会自己脑补。
    const turns = [asst('看看', [call('Read', { file_path: '/p/a.ts' }), call('Grep', { pattern: 'x' })])]
    const ex = excerptTurns(turns, 0, {})
    expect(ex.text).toContain('Read(')
    expect(ex.text).toContain('Grep(')
    expect(ex.text.trim()).not.toBe('')
  })

  test('maxEvidenceChars 管单个证据串的长度', () => {
    const turns = [asst('', [call('Bash', { command: 'x' }, res([ev('output', 'x'.repeat(500))]))])]
    const ex = excerptTurns(turns, 0, { maxEvidenceChars: 20 })
    expect(ex.text).toContain(`! ${'x'.repeat(19)}…`)
    expect(ex.text).not.toContain('x'.repeat(30))
  })

  test('maxEvidenceLines 管兜底那几条', () => {
    const calls = Array.from({ length: 5 }, (_, i) => call(`T${i}`, { i }))
    const ex = excerptTurns([asst('', calls)], 0, { maxEvidenceLines: 2 })
    expect(evidenceText(ex).length).toBe(2)
  })
})

describe('★ 裁剪必须留痕', () => {
  test('裁过就写进 text 里 —— 只留在返回值里，读它的模型看不见', () => {
    // 这是整份文件契约的一部分，不是装饰。不留痕的话，AI 会把残缺的上下文
    // 当成全部，编出一个看似合理但错的因果解释 —— 卡片看着很有道理，
    // 而「为什么」是编的。那是这个工具最坏的一种失败。
    const turns = [
      asst('干活', [call('Read', { file_path: '/p/a.ts' }, res([ev('file', '/p/a.ts:1')]))]),
      human('我'.repeat(300)),
      human('你'.repeat(300)),
    ]
    const ex = excerptTurns(turns, 0, { budget: 30 })
    expect(ex.text).toContain('省掉了 2 行')
    expect(ex.text).toContain('证据行已优先保留')
    expect(ex.truncated).toBe(true)
    expect(ex.omittedTurns).toBe(2)
  })

  test('没裁就别留痕 —— 在完整的上下文里谎称裁过同样会误导', () => {
    const ex = excerptTurns([human('一句话')], 0, {})
    expect(ex.text).not.toContain('省掉了')
    expect(ex.truncated).toBe(false)
    expect(ex.omittedTurns).toBe(0)
  })

  test('痕迹本身也算进 tokens —— 它不是白送的', () => {
    const turns = [asst('', [call('Read', { file_path: '/p/a.ts' }, res([ev('file', '/p/a.ts:1')]))]), human('我'.repeat(300))]
    const ex = excerptTurns(turns, 0, { budget: 30 })
    expect(ex.tokens).toBe(estimateTokens(ex.text))
  })
})

describe('sessionHeader', () => {
  const s: Session = {
    ...emptySession('claude-code', '/p/a.jsonl', 's1'),
    cwd: '/p',
    gitBranch: 'main',
    startedAt: '2026-10-14T09:00:00Z',
    turns: [human('我猜是顺序问题'), asst('好', [call('Read', {}), call('Edit', {})])],
  }

  test('带项目与规模，且**不含任何对话内容**', () => {
    const h = sessionHeader(s)
    expect(h).toContain('claude-code')
    expect(h).toContain('/p')
    expect(h).toContain('2 回合 / 2 次工具调用')
    // 这是它存在的唯一理由：给 AI 定位，不是给它素材
    expect(h).not.toContain('我猜是顺序问题')
  })

  test('没记到的字段整行不出现，不写「undefined」', () => {
    const bare = sessionHeader({ ...emptySession('codex', '/x.jsonl', 's2'), cwd: '/x' })
    expect(bare).not.toContain('分支')
    expect(bare).not.toContain('开始')
    expect(bare).not.toContain('undefined')
  })
})
