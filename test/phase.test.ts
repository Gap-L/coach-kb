import { describe, expect, test } from 'bun:test'
import { DEFAULT_STATE, advance, phaseLine, predictionsFrom, type CoachState } from '../src/core/phase.ts'
import { clip } from '../src/core/heuristics.ts'

function st(over: Partial<CoachState> = {}): CoachState {
  return { ...DEFAULT_STATE, ...over }
}

const HEAVY = '帮我重构一下鉴权那部分，中间件顺序好像不太对，为什么有时候不进链里'

describe('advance 的阶段机', () => {
  test('idle + 值得教练 → ask，并记一次任务', () => {
    const r = advance(st(), HEAVY, false)
    expect(r.state.task?.phase).toBe('ask')
    expect(r.state.stats.tasks).toBe(1)
    expect(r.line).not.toBe('')
    expect(r.gagged).toBe(false)
  })

  test('idle + 不值得 → 原样返回，一个字都不说', () => {
    const before = st()
    const r = advance(before, '帮我改个错别字', false)
    expect(r.line).toBe('')
    expect(r.state.task).toBeNull()
    expect(r.state.stats.tasks).toBe(0)
  })

  test('★ ask → contrast：用户那句话**逐字**存下来', () => {
    // 这是整条链最值钱的一步 —— 卡片「我自己的表述」就是从这儿来的。
    // 任何改写、摘要、trim 之外的加工都会毁掉它。
    const asked = advance(st(), HEAVY, false).state
    const words = '我猜是挂载顺序，因为 use 写在路由后面'
    const r = advance(asked, words, false)
    expect(r.state.task?.phase).toBe('contrast')
    expect(r.state.task?.prediction).toBe(words)
  })

  test('★ A → B 时把用户的原话逐字摆回去 —— 那是他唯一会看见自己判断的时刻', () => {
    const asked = advance(st(), HEAVY, false).state
    const words = '我猜是挂载顺序，因为 use 写在路由后面'
    const r = advance(asked, words, false)
    expect(r.state.task?.phase).toBe('contrast')
    expect(r.line).toContain(`「${words}」`) // 带引号原样嵌入，没有摘要
  })

  test('B → C 那一行**故意不重复**判断 —— B 那轮刚说过，上下文是公共预算', () => {
    const asked = advance(st(), HEAVY, false).state
    const contrasted = advance(asked, '我猜是挂载顺序', false).state
    const r = advance(contrasted, '嗯', false)
    expect(r.state.task?.phase).toBe('execute')
    expect(r.line).not.toContain('我猜是挂载顺序')
    // 但四行复盘的要求必须带上 —— 判断不在 prompt 里，在对话里
    expect(r.line).toContain('复盘')
    expect(r.line).toContain('和你的判断差在哪')
  })

  test('★ execute + quiet（上一轮没动任何工具）= 上一件事翻篇了，可以开新一轮', () => {
    // quiet 的语义容易记反。它的意思是「上一轮只是聊天，没干活」——
    // 那么现在这句正经请求就是新的一件事，该重新问一遍。
    const asked = advance(st(), HEAVY, false).state
    const contrasted = advance(asked, '我猜是挂载顺序', false).state
    const executing = advance(contrasted, '嗯', false).state
    expect(executing.task?.phase).toBe('execute')
    const r = advance(executing, HEAVY, true)
    expect(r.state.stats.tasks).toBe(2)
    expect(r.state.task?.prediction).toBe('') // 新一轮，还没有判断
  })

  test('execute + 不 quiet（上一轮动过工具）= 同一件事的追问，不许再问一遍', () => {
    // 没有这个信号，任务里每句追问都会被重新反问一次 —— 那是折磨。
    const asked = advance(st(), HEAVY, false).state
    const contrasted = advance(asked, '我猜是挂载顺序', false).state
    const executing = advance(contrasted, '嗯', false).state
    const r = advance(executing, HEAVY, false)
    expect(r.state.stats.tasks).toBe(1)
    expect(r.state.task?.prediction).toBe('我猜是挂载顺序') // 判断还在
    expect(r.line).toContain('阶段 C') // 继续提醒他别忘了复盘收尾
  })
})

describe('跳过与闭嘴', () => {
  test('★ 连着跳过两次就闭嘴 —— 别把用户逼到关掉它', () => {
    const asked = advance(st(), HEAVY, false).state
    const first = advance(asked, '跳过', false)
    expect(first.gagged).toBe(false)
    expect(first.state.level).toBe('lite')
    expect(first.state.stats.consecutiveSkips).toBe(1)

    const second = advance(first.state, '跳过', false)
    expect(second.gagged).toBe(true)
    expect(second.state.level).toBe('off')
    expect(second.state.stats.skips).toBe(2)
  })

  test('没在教练中的跳过不算数，也不累计', () => {
    // 用户平时说一句「不用了」不该被记成「他跳过了教练」
    const r = advance(st(), '不用了', false)
    expect(r.gagged).toBe(false)
    expect(r.line).toBe('')
    expect(r.state.stats.skips).toBe(0)
    expect(r.state.stats.consecutiveSkips).toBe(0)
  })

  test('跳过之后任务进 execute（不再追问），但保留原任务', () => {
    const asked = advance(st(), HEAVY, false).state
    const r = advance(asked, '跳过', false)
    expect(r.state.task?.phase).toBe('execute')
    expect(r.state.task?.isSkipped).toBe(true)
  })

  test('新任务会把 consecutiveSkips 清零 —— 他又愿意聊了', () => {
    const asked = advance(st(), HEAVY, false).state
    const skipped = advance(asked, '跳过', false).state
    expect(skipped.stats.consecutiveSkips).toBe(1)
    const r = advance({ ...skipped, task: null }, HEAVY, false)
    expect(r.state.stats.consecutiveSkips).toBe(0)
  })
})

describe('predictionsFrom —— 沉淀层和提问层的接缝', () => {
  test('把用户说过的判断从会话里捞回来', () => {
    // 旧实现挂在 `DEBRIEF_RE.test(模型输出)` 上，于是什么也没捞到。
    // 这一条是从**会话日志**里捡，模型写不写那句话都不影响。
    const turns = [
      { role: 'human', text: HEAVY, toolCalls: [] },
      { role: 'assistant', text: '你打算先从哪里入手？', toolCalls: [] },
      { role: 'human', text: '我觉得是中间件顺序的问题', toolCalls: [] },
      { role: 'assistant', text: '…', toolCalls: [{}] },
      { role: 'human', text: '嗯', toolCalls: [] },
    ]
    expect(predictionsFrom(turns)).toEqual(['我觉得是中间件顺序的问题'])
  })

  test('没说过判断就只有空数组，不硬造一个出来', () => {
    const turns = [
      { role: 'human', text: '帮我改个错别字', toolCalls: [] },
      { role: 'assistant', text: '好', toolCalls: [{}] },
    ]
    expect(predictionsFrom(turns)).toEqual([])
  })

  test('同一句判断不会被记两遍', () => {
    const turns = [
      { role: 'human', text: HEAVY, toolCalls: [] },
      { role: 'human', text: '我觉得是顺序问题', toolCalls: [] },
      { role: 'human', text: '嗯', toolCalls: [] },
    ]
    const got = predictionsFrom(turns)
    expect(got).toEqual(['我觉得是顺序问题'])
  })
})

describe('phaseLine', () => {
  test('对照那一行把用户的原话带出来，不加工', () => {
    expect(phaseLine('contrast', '我猜是顺序')).toContain('我猜是顺序')
  })

  test('行文短 —— 它要出现在每次对话的上下文里', () => {
    for (const p of ['ask', 'contrast', 'execute', 'idle'] as const) {
      expect(phaseLine(p, '我猜是顺序').length).toBeLessThan(500)
    }
  })

  test('长得离谱的判断会被裁到 300 字 —— 上下文是公共预算', () => {
    const huge = '啊'.repeat(2000)
    const line = phaseLine('contrast', huge)
    // 上限是 300（clip 会吃掉一个字换成省略号），断言这个确切值而不是「小于 2000」——
    // 后者在 cap 被误改成 1800 时照样绿。
    expect(line).toContain(`「${clip(huge, 300)}」`)
    expect(line).not.toContain('啊'.repeat(301))
  })
})
