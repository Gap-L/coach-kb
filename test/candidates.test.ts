import { describe, expect, test } from 'bun:test'
import { tagsOf, titleOf, toCandidates, typeOfSignal } from '../src/core/candidates.ts'
import { cleanEvidence } from '../src/commands/sink.ts'
import type { Signal } from '../src/core/model.ts'

function sig(over: Partial<Signal> = {}): Signal {
  return {
    kind: 'repeat_edit',
    confidence: 0.6,
    turnIndex: 10,
    why: 'src/a.ts 被改了 3 次 —— 一次没改对，通常说明动手前没想清楚',
    evidence: [{ kind: 'file', text: 'src/a.ts:88' }],
    ...over,
  }
}

// ---------------------------------------------------------------------------

describe('typeOfSignal', () => {
  test('每个已知信号都有归属', () => {
    expect(typeOfSignal('repeat_error')).toBe('pitfall')
    expect(typeOfSignal('user_correction')).toBe('pattern')
    expect(typeOfSignal('repeat_edit')).toBe('pitfall')
    expect(typeOfSignal('long_debug')).toBe('playbook')
    expect(typeOfSignal('learned')).toBe('concept')
    expect(typeOfSignal('user_prediction')).toBe('pattern')
  })

  // 宿主升级会带来新信号类型。丢掉它 = 用户永远看不到它。
  test('不认识的类型不丢，归到 concept', () => {
    expect(typeOfSignal('未来才有的信号')).toBe('concept')
  })
})

describe('titleOf', () => {
  // 标题必须**来自证据**。写出「关于反复修改的思考」这种标题，
  // 卡片就变成了 AI 摘要 —— 本项目要避免的正是这个。
  test('repeat_edit 用证据里的路径，不用泛泛的说法', () => {
    const t = titleOf(sig())
    expect(t).toContain('src/a.ts')
    expect(t).not.toContain('思考')
  })

  test('repeat_error 从 why 里取出报错原文', () => {
    const t = titleOf(sig({ kind: 'repeat_error', why: '同一个报错出现了 3 次：TS2307 Cannot find module' }))
    expect(t).toBe('反复踩的坑：TS2307 Cannot find module')
  })

  test('用户说的话直接进标题', () => {
    expect(titleOf(sig({ kind: 'user_correction', userWords: '我说的是先读再改' }))).toBe('我纠正过：我说的是先读再改')
    expect(titleOf(sig({ kind: 'learned', userWords: '原来如此' }))).toBe('想通了：原来如此')
  })

  test('没有 userWords 时给一句中性的，而不是崩', () => {
    expect(titleOf(sig({ kind: 'learned', userWords: undefined }))).toBe('我自己说的「原来如此」')
  })

  test('没有证据时不编造，退回一个诚实的说法', () => {
    expect(titleOf(sig({ evidence: [] }))).toBe('同一处反复修改')
  })

  test('长路径被缩短，标题不会长到看不完', () => {
    const t = titleOf(sig({ evidence: [{ kind: 'file', text: '/Users/someone/very/deep/nested/project/src/adapters/x/y/parse.ts' }] }))
    expect(t.length).toBeLessThan(60)
    expect(t).toContain('parse.ts')
  })

  test('换行被压平 —— 标题里不能有换行', () => {
    expect(titleOf(sig({ kind: 'repeat_error', why: '同一个报错出现了 2 次：foo\nbar' }))).not.toContain('\n')
  })
})

describe('toCandidates', () => {
  test('index 从 0 连续编号', () => {
    const cs = toCandidates([sig({ turnIndex: 3 }), sig({ turnIndex: 1 })])
    expect(cs.map(c => c.index)).toEqual([0, 1])
  })

  // 顺序影响 index，index 进卡片 id 的哈希输入。
  // 排序不稳定 = 同一会话跑两次得到不同的卡片 id = 知识库里长出双胞胎。
  test('排序稳定：按轮次，再按 kind', () => {
    const a = toCandidates([sig({ turnIndex: 5, kind: 'learned' }), sig({ turnIndex: 5, kind: 'repeat_edit' }), sig({ turnIndex: 2, kind: 'repeat_edit' })])
    expect(a.map(c => [c.turnIndex, c.kind])).toEqual([
      [2, 'repeat_edit'],
      [5, 'learned'],
      [5, 'repeat_edit'],
    ])
    // 打乱输入，结果必须一样
    const b = toCandidates([sig({ turnIndex: 2, kind: 'repeat_edit' }), sig({ turnIndex: 5, kind: 'learned' }), sig({ turnIndex: 5, kind: 'repeat_edit' })])
    expect(b.map(c => c.index)).toEqual(a.map(c => c.index))
    expect(b.map(c => c.title)).toEqual(a.map(c => c.title))
  })

  test('limit 生效', () => {
    const many = Array.from({ length: 50 }, (_, i) => sig({ turnIndex: i }))
    expect(toCandidates(many, { limit: 7 })).toHaveLength(7)
  })

  test('空 userWords 不带上 —— 免得提示词里多一行噪音', () => {
    const [c] = toCandidates([sig({ userWords: '' })])
    expect(c?.userWords).toBeUndefined()
  })

  test('kind 与 turnIndex 带下去了（id 和摘要窗口都要用）', () => {
    const [c] = toCandidates([sig({ kind: 'repeat_error', turnIndex: 42 })])
    expect(c?.kind).toBe('repeat_error')
    expect(c?.turnIndex).toBe(42)
  })
})

describe('tagsOf', () => {
  test('从证据路径里抽文件名主干', () => {
    const [c] = toCandidates([sig({ evidence: [{ kind: 'file', text: 'src/auth/middleware.ts:88' }] })])
    expect(tagsOf(c!)).toContain('middleware')
  })

  // 多段扩展名（`parse.claude.test.ts`）取的是**第一个** `主干.扩展` 对，
  // 也就是 `parse`。不是 `test` —— 那是后缀不是名字。这条钉住这个选择，
  // 免得哪天顺手改成「取最后一个点」，让所有 `.test.ts` 的卡都挂上 `test` 标签。
  test('多段扩展名取第一个点之前的词', () => {
    const t = tagsOf({ index: 0, title: 'x', type: 'pitfall', kind: 'k', why: '', evidence: ['coach-kb/test/parse.claude.test.ts:45'] })
    expect(t).toEqual(['parse'])
  })

  test('最多 6 个，且不重复', () => {
    const ev = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts:1`).concat(['src/file0.ts:2'])
    const t = tagsOf({ index: 0, title: 'x', type: 'pitfall', kind: 'k', why: '', evidence: ev })
    expect(t.length).toBeLessThanOrEqual(6)
    expect(new Set(t).size).toBe(t.length)
  })

  test('太短的词不当 tag（一个字母的文件名没有检索价值）', () => {
    const t = tagsOf({ index: 0, title: 'x', type: 'pitfall', kind: 'k', why: '', evidence: ['a/b.ts:1'] })
    expect(t).not.toContain('b')
  })
})

// ---------------------------------------------------------------------------

describe('cleanEvidence', () => {
  // 这条是实测踩出来的：真实会话里 Edit 的 newString 会被整段当成证据，
  // 一段 400 字的散文把卡片撑成一屏半，人就不看了。
  test('超长的截断到 160 字', () => {
    const long = 'x'.repeat(500)
    const [one] = cleanEvidence([long])
    expect(one?.length).toBe(160)
    expect(one?.endsWith('…')).toBe(true)
  })

  test('换行被压平 —— 多行内容会打断 markdown 列表项', () => {
    expect(cleanEvidence(['a\nb\n\nc'])[0]).toBe('a b c')
  })

  test('代码块里的换行也压平', () => {
    const [one] = cleanEvidence(['function f() {\n  return 1\n}'])
    expect(one).not.toContain('\n')
  })

  test('去重', () => {
    expect(cleanEvidence(['a', 'a', 'b'])).toEqual(['a', 'b'])
  })

  test('去重发生在截断之后 —— 两条长的前 160 字相同就算重', () => {
    const base = 'y'.repeat(200)
    expect(cleanEvidence([base + 'AAA', base + 'BBB'])).toHaveLength(1)
  })

  test('空串和纯空白被丢掉', () => {
    expect(cleanEvidence(['', '   ', '\n', 'real'])).toEqual(['real'])
  })

  test('最多 8 条', () => {
    const many = Array.from({ length: 30 }, (_, i) => `evidence-${i}`)
    expect(cleanEvidence(many)).toHaveLength(8)
  })

  test('正好 160 字不加省略号', () => {
    const exact = 'z'.repeat(160)
    expect(cleanEvidence([exact])[0]).toBe(exact)
  })
})
