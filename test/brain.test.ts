import { afterEach, describe, expect, test } from 'bun:test'
import { BRAINS, distillWithFallback, getBrain, isBrainName } from '../src/brain/index.ts'
import { clip, extractJson, readResultPayload } from '../src/brain/json.ts'
import { buildPrompt, reconcile } from '../src/brain/prompt.ts'
import { noneBrain } from '../src/brain/none.ts'
import type { Brain, BrainOptions, BrainResult, Candidate, DistillInput } from '../src/brain/types.ts'
import { BRAIN_SENTINEL, insideBrainCall, sentinelEnv } from '../src/brain/types.ts'

const OPTS: BrainOptions = { timeoutMs: 1000, cwd: '/tmp' }

const CANDIDATES: Candidate[] = [
  { index: 0, title: '改之前先读文件', type: 'pitfall', kind: 'repeat_edit', why: '同一文件改了 7 次', evidence: ['src/a.ts:88'] },
  { index: 1, title: '报错签名要归一化', type: 'pattern', kind: 'repeat_error', why: '同一报错出现 4 次', evidence: ['TS2307'] },
]

function input(): DistillInput {
  return { header: '工具: claude-code', excerpt: '  · src/a.ts:88', candidates: CANDIDATES }
}

// ---------------------------------------------------------------------------

describe('extractJson', () => {
  test('裸数组', () => {
    expect(extractJson('[{"index":0}]')).toEqual([{ index: 0 }])
  })

  test('裹着围栏', () => {
    expect(extractJson('```json\n[{"index":0}]\n```')).toEqual([{ index: 0 }])
  })

  test('前后有客套话', () => {
    expect(extractJson('好的,这是结果:\n[{"index":1}]\n希望有帮助!')).toEqual([{ index: 1 }])
  })

  test('嵌套括号数得清', () => {
    const s = '[{"index":0,"tags":["a"],"meta":{"x":[1,2]}}]'
    expect(extractJson(s)).toEqual([{ index: 0, tags: ['a'], meta: { x: [1, 2] } }])
  })

  // 手写配平而不是用正则，就是为了这一条
  test('字符串里的括号不算数', () => {
    const s = '[{"ai":"看到 [Error] 这个标记","transfer":"先跑 npm test"}]'
    expect(extractJson(s)).toEqual([{ ai: '看到 [Error] 这个标记', transfer: '先跑 npm test' }])
  })

  test('转义的引号不算数', () => {
    const s = '[{"ai":"他说 \\"算了\\" 然后 [就这样]"}]'
    expect(extractJson(s)).toEqual([{ ai: '他说 "算了" 然后 [就这样]' }])
  })

  test('对象也能取', () => {
    expect(extractJson('前置\n{"drafts":[]}')).toEqual({ drafts: [] })
  })

  test('解析不了返回 null，不抛', () => {
    expect(extractJson('模型今天不想干活')).toBeNull()
    expect(extractJson('')).toBeNull()
    expect(extractJson('[{"index":')).toBeNull()
  })
})

describe('readResultPayload', () => {
  test('跳过前面的告警行', () => {
    const stdout = [
      '[claude-code:unrecognized_model] {"model":"x"}',
      '{"type":"system","subtype":"init"}',
      '{"type":"result","subtype":"success","is_error":false,"result":"OK","total_cost_usd":0.1,"usage":{"input_tokens":5,"output_tokens":2}}',
    ].join('\n')
    const p = readResultPayload(stdout)
    expect(p?.text).toBe('OK')
    expect(p?.isError).toBe(false)
    expect(p?.usage).toEqual({ inputTokens: 5, outputTokens: 2, costUsd: 0.1 })
  })

  test('多个 result 时取最后一个', () => {
    const stdout = ['{"type":"result","result":"旧"}', '{"type":"result","result":"新"}'].join('\n')
    expect(readResultPayload(stdout)?.text).toBe('新')
  })

  test('is_error 被抓到', () => {
    const p = readResultPayload('{"type":"result","is_error":true,"result":"炸了"}')
    expect(p?.isError).toBe(true)
  })

  test('没有 result 行返回 null', () => {
    expect(readResultPayload('{"type":"system"}')).toBeNull()
    expect(readResultPayload('')).toBeNull()
  })

  test('usage 缺字段时补 0，不产生 undefined', () => {
    const p = readResultPayload('{"type":"result","result":"x"}')
    expect(p?.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 })
  })
})

describe('clip', () => {
  test('把换行压平', () => {
    expect(clip('a\n\nb', 20)).toBe('a b')
  })
  test('超长才截断', () => {
    expect(clip('abcdef', 4)).toBe('abc…')
    expect(clip('abc', 10)).toBe('abc')
  })
})

// ---------------------------------------------------------------------------

describe('reconcile', () => {
  test('正常对上', () => {
    const r = reconcile([{ index: 0, ai: '因为 A', transfer: '先 B' }], CANDIDATES)
    expect(r.drafts).toEqual([{ index: 0, ai: '因为 A', transfer: '先 B' }])
    expect(r.dropped).toContain('index=1 模型没给出')
  })

  test('index 不在候选表里 → 丢掉，不猜', () => {
    const r = reconcile([{ index: 9, ai: 'x', transfer: 'y' }], CANDIDATES)
    expect(r.drafts).toEqual([])
    expect(r.dropped.some(d => d.includes('index=9'))).toBe(true)
  })

  test('重复 index → 只留第一个', () => {
    const r = reconcile([{ index: 0, ai: '第一版' }, { index: 0, ai: '第二版' }], CANDIDATES)
    expect(r.drafts).toHaveLength(1)
    expect(r.drafts[0]?.ai).toBe('第一版')
    expect(r.dropped.some(d => d.includes('重复'))).toBe(true)
  })

  test('字符串形式的 index 也认', () => {
    expect(reconcile([{ index: '1', ai: 'x' }], CANDIDATES).drafts[0]?.index).toBe(1)
  })

  test('不是数组 → 全丢并说明', () => {
    const r = reconcile({ index: 0 }, CANDIDATES)
    expect(r.drafts).toEqual([])
  })

  test('缺 ai / transfer 时给空串而不是崩', () => {
    expect(reconcile([{ index: 0 }], CANDIDATES).drafts[0]).toEqual({ index: 0, ai: '', transfer: '' })
  })

  test('tags 过滤掉非字符串，最多 6 个', () => {
    const r = reconcile([{ index: 0, ai: '', transfer: '', tags: ['a', 1, '', 'b', 'c', 'd', 'e', 'f', 'g'] }], CANDIDATES)
    expect(r.drafts[0]?.tags).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  test('confidence 越界就丢掉，不瞎夹', () => {
    expect(reconcile([{ index: 0, confidence: 1.5 }], CANDIDATES).drafts[0]?.confidence).toBeUndefined()
    expect(reconcile([{ index: 0, confidence: 0.3 }], CANDIDATES).drafts[0]?.confidence).toBe(0.3)
  })

  test('非对象条目不会让整批失败', () => {
    const r = reconcile([null, 'x', { index: 0, ai: 'ok' }], CANDIDATES)
    expect(r.drafts).toHaveLength(1)
    expect(r.dropped).toHaveLength(3) // 两个坏条目 + index=1 没给出
  })
})

describe('buildPrompt', () => {
  test('三个占位符都被替换掉', () => {
    const p = buildPrompt(input())
    expect(p).not.toContain('${HEADER}')
    expect(p).not.toContain('${EXCERPT}')
    expect(p).not.toContain('${CANDIDATES}')
    expect(p).toContain('工具: claude-code')
    expect(p).toContain('src/a.ts:88')
  })

  test('候选带编号、类型、触发原因与证据', () => {
    const p = buildPrompt(input())
    expect(p).toContain('### [0] 改之前先读文件')
    expect(p).toContain('类型: pitfall')
    expect(p).toContain('为什么成为候选: 同一文件改了 7 次')
  })

  test('用户原话会带上，好让 AI 的解释与之呼应', () => {
    const i = input()
    i.candidates = [{ ...CANDIDATES[0]!, userWords: '我打算先读一遍' }]
    expect(buildPrompt(i)).toContain('使用者当时说: 「我打算先读一遍」')
  })

  test('用户原话过长会截断', () => {
    const i = input()
    i.candidates = [{ ...CANDIDATES[0]!, userWords: 'x'.repeat(1000) }]
    expect(buildPrompt(i)).toContain('x'.repeat(300))
    expect(buildPrompt(i)).not.toContain('x'.repeat(301))
  })
})

// ---------------------------------------------------------------------------

describe('注册表', () => {
  test('四个脑都在', () => {
    expect(Object.keys(BRAINS).sort()).toEqual(['claude', 'codex', 'http', 'none'])
  })
  test('认得出名字', () => {
    expect(isBrainName('claude')).toBe(true)
    expect(isBrainName('gpt5')).toBe(false)
  })
  test('未知名字落到 none，不抛', () => {
    expect(getBrain('不存在').name).toBe('none')
  })
})

describe('哨兵', () => {
  test('sentinelEnv 设上了标记，同时继承原有环境', () => {
    const env = sentinelEnv()
    expect(env[BRAIN_SENTINEL]).toBe('1')
    expect(env['PATH']).toBe(process.env['PATH'] as string)
  })

  test('insideBrainCall 认得出自己', () => {
    const before = process.env[BRAIN_SENTINEL]
    expect(insideBrainCall()).toBe(before === '1')
    process.env[BRAIN_SENTINEL] = '1'
    expect(insideBrainCall()).toBe(true)
    if (before === undefined) delete process.env[BRAIN_SENTINEL]
    else process.env[BRAIN_SENTINEL] = before
  })
})

describe('none 脑', () => {
  test('不产出散文，但候选一条不少（这是它的全部价值）', async () => {
    const r = await noneBrain.distill(input(), OPTS)
    expect(r.drafts).toEqual([
      { index: 0, ai: '', transfer: '' },
      { index: 1, ai: '', transfer: '' },
    ])
    expect(r.degraded).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------

describe('distillWithFallback', () => {
  const original = { ...BRAINS }

  afterEach(() => {
    for (const k of Object.keys(BRAINS)) delete BRAINS[k]
    Object.assign(BRAINS, original)
  })

  const fake = (name: string, fn: () => Promise<BrainResult>): Brain => ({
    name,
    probe: async () => ({ ok: true, detail: 'fake' }),
    distill: fn,
  })

  test('选 none 时不碰别的脑', async () => {
    let called = false
    BRAINS['claude'] = fake('claude', async () => {
      called = true
      return { brain: 'claude', drafts: [] }
    })
    const r = await distillWithFallback(input(), { ...OPTS, brain: 'none' })
    expect(called).toBe(false)
    expect(r.drafts).toHaveLength(2)
  })

  test('脑子抛异常 → 降级成骨架卡，但保留原脑名字与原因', async () => {
    BRAINS['claude'] = fake('claude', async () => {
      throw new Error('端点连不上')
    })
    const r = await distillWithFallback(input(), { ...OPTS, brain: 'claude' })
    expect(r.drafts).toHaveLength(2) // 候选没丢
    expect(r.drafts.every(d => d.ai === '')).toBe(true)
    expect(r.brain).toBe('claude') // 名字还是 claude，好让人知道是它失败了
    expect(r.degraded).toContain('端点连不上')
  })

  test('脑子返回空 → 也是降级，且说明原因', async () => {
    BRAINS['claude'] = fake('claude', async () => ({ brain: 'claude', drafts: [], degraded: '模型输出不是 JSON' }))
    const r = await distillWithFallback(input(), { ...OPTS, brain: 'claude' })
    expect(r.drafts).toHaveLength(2)
    expect(r.degraded).toContain('模型输出不是 JSON')
  })

  test('脑子成功时原样返回，不掺 degraded', async () => {
    BRAINS['claude'] = fake('claude', async () => ({
      brain: 'claude',
      drafts: [{ index: 0, ai: '因为 A', transfer: '先 B' }],
      usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.001, ms: 5 },
    }))
    const r = await distillWithFallback(input(), { ...OPTS, brain: 'claude' })
    expect(r.drafts).toHaveLength(1)
    expect(r.degraded).toBeUndefined()
    expect(r.usage?.costUsd).toBe(0.001)
  })

  test('预算用尽就不调模型，直接骨架卡并说明', async () => {
    let called = false
    BRAINS['claude'] = fake('claude', async () => {
      called = true
      return { brain: 'claude', drafts: [{ index: 0, ai: 'x', transfer: 'y' }] }
    })
    const r = await distillWithFallback(input(), { ...OPTS, brain: 'claude', budgetUsd: 0 })
    expect(called).toBe(false)
    expect(r.degraded).toContain('额度')
  })
})
