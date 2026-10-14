import { describe, expect, test } from 'bun:test'
import { buildSections, renderReport, weekLabel } from '../src/commands/digest.ts'
import type { Card } from '../src/core/card.ts'
import type { CoachStateFile } from '../src/core/state.ts'

function card(over: Partial<Card> = {}): Card {
  return {
    id: 'kb-pitfall-aaaaaa',
    title: '反复踩的坑：ECONNREFUSED',
    type: 'pitfall',
    tags: [],
    status: 'confirmed',
    confidence: 0.6,
    why: '',
    mine: '我原来以为是网络，其实是本地服务没起。',
    ai: '',
    evidence: ['/p/src/db.ts:12'],
    transfer: '先 curl 一下本地端口。',
    links: [],
    signals: [],
    source: { tool: 'claude-code', session: 'sess-1', cwd: '/p', date: '2026-10-14' },
    review: { count: 0 },
    ...over,
  }
}

/** 只喂 buildSections 真正读的那两块 state。 */
function ctxOf(state: Partial<CoachStateFile>): Parameters<typeof buildSections>[0] {
  return { state: { sessions: {}, digest: { spentDate: '', spentTodayUsd: 0, spendByDate: {} }, ...state } } as unknown as Parameters<
    typeof buildSections
  >[0]
}

const META = { start: '2026-10-08', end: '2026-10-14', label: '2026-W42', kb: '/kb' }

describe('weekLabel', () => {
  test('普通周', () => {
    expect(weekLabel('2026-10-14')).toBe('2026-W42')
  })

  test('★ 跨年：1 月 1 日可能属于上一年的最后一周', () => {
    // 这就是为什么 isoWeek 返回 {year, week} 两个字段，而不是让人去 slice 日期串
    expect(weekLabel('2027-01-01')).toBe('2026-W53')
    expect(weekLabel('2024-12-30')).toBe('2025-W01')
    expect(weekLabel('2025-12-29')).toBe('2026-W01')
  })

  test('周号补零到两位 —— 文件名排序才跟时间一致', () => {
    expect(weekLabel('2026-01-08')).toBe('2026-W02')
  })
})

describe('buildSections 的每个数都得有出处', () => {
  test('窗口是**闭区间**，含首尾两天', () => {
    const onStart = card({ id: 'kb-pitfall-s', source: { tool: 't', session: 's', cwd: '/p', date: '2026-10-08' } })
    const onEnd = card({ id: 'kb-pitfall-e', source: { tool: 't', session: 's', cwd: '/p', date: '2026-10-14' } })
    const outside = card({ id: 'kb-pitfall-o', source: { tool: 't', session: 's', cwd: '/p', date: '2026-10-15' } })
    const s = buildSections(ctxOf({}), [onStart, onEnd, outside], META.start, META.end)
    expect(s.learned.map(c => c.id)).toEqual(['kb-pitfall-s', 'kb-pitfall-e'])
  })

  test('日期是空串的卡不算「这周学到的」（别把它算在今天）', () => {
    const broken = card({ source: { tool: 't', session: 's', cwd: '/p', date: '' } })
    expect(buildSections(ctxOf({}), [broken], META.start, META.end).learned).toEqual([])
  })

  test('★ 蒸馏过几场会话来自 state，不是猜的 —— 周报的诚实声明靠它', () => {
    const s = buildSections(
      ctxOf({
        sessions: {
          '/x/a.jsonl': { path: '/x/a.jsonl', size: 1, mtimeMs: 1, lines: 0, lastProcessedAt: '2026-10-12T03:00:00.000Z', cardsEmitted: [] },
          '/x/b.jsonl': { path: '/x/b.jsonl', size: 1, mtimeMs: 1, lines: 0, lastProcessedAt: '2026-09-01T03:00:00.000Z', cardsEmitted: [] },
        },
      }),
      [],
      META.start,
      META.end,
    )
    expect(s.distilledSessions.map(d => d.sessionId)).toEqual(['a'])
  })

  test('反复踩的坑：要 ≥2 个**不同会话**，且至少一张卡落在窗口里', () => {
    const sameTitle = (id: string, session: string, date: string): Card =>
      card({ id, title: '同一个坑', source: { tool: 't', session, cwd: '/p', date } })

    const twoSessions = [sameTitle('kb-pitfall-1', 's1', '2026-10-10'), sameTitle('kb-pitfall-2', 's2', '2026-10-11')]
    expect(buildSections(ctxOf({}), twoSessions, META.start, META.end).recurring.length).toBe(1)
    expect(buildSections(ctxOf({}), twoSessions, META.start, META.end).recurring[0]?.sessions.length).toBe(2)

    // 同一个会话里出现两次不算「反复」—— 那是同一次踩坑的两条证据
    const oneSession = [sameTitle('kb-pitfall-1', 's1', '2026-10-10'), sameTitle('kb-pitfall-2', 's1', '2026-10-11')]
    expect(buildSections(ctxOf({}), oneSession, META.start, META.end).recurring).toEqual([])

    // 两次都在窗口外 = 以前反复踩的，不是这周的
    const old = [sameTitle('kb-pitfall-1', 's1', '2026-08-01'), sameTitle('kb-pitfall-2', 's2', '2026-08-02')]
    expect(buildSections(ctxOf({}), old, META.start, META.end).recurring).toEqual([])
  })

  test('inbox 就是「还没写自己那句话」的那些，按躺的天数降序', () => {
    const fresh = card({ id: 'kb-pitfall-f', mine: '', source: { tool: 't', session: 's', cwd: '/p', date: '2026-10-14' } })
    const old = card({ id: 'kb-pitfall-o', mine: '', source: { tool: 't', session: 's', cwd: '/p', date: '2026-09-20' } })
    const done = card({ id: 'kb-pitfall-d', mine: '我自己的话' })
    const s = buildSections(ctxOf({}), [fresh, old, done], META.start, META.end)
    expect(s.inbox.map(i => i.card.id)).toEqual(['kb-pitfall-o', 'kb-pitfall-f'])
    expect(s.inbox[0]?.ageDays).toBe(24)
  })

  test('坏日期的卡不会让报表崩（ageDays 归 0）', () => {
    const broken = card({ mine: '', source: { tool: 't', session: 's', cwd: '/p', date: 'не дата' } })
    expect(buildSections(ctxOf({}), [broken], META.start, META.end).inbox[0]?.ageDays).toBe(0)
  })

  test('花费只算窗口内的流水', () => {
    const s = buildSections(
      ctxOf({ digest: { spentDate: '2026-10-14', spentTodayUsd: 0.3, spendByDate: { '2026-10-14': 0.3, '2026-10-09': 0.2, '2026-10-01': 9.9 } } }),
      [],
      META.start,
      META.end,
    )
    expect(s.spend.byDate.map(([d]) => d)).toEqual(['2026-10-09', '2026-10-14'])
    expect(s.spend.total).toBeCloseTo(0.5, 6)
  })
})

describe('renderReport 的诚实性', () => {
  test('★ 这周没蒸馏过就必须先说清楚：下面的数是存量，不是产出', () => {
    // 没有这句话，「这周学到 0 条」会被读成「我这周什么也没学到」
    const body = renderReport(buildSections(ctxOf({}), [], META.start, META.end), META)
    expect(body).toContain('这一周没有蒸馏过任何会话')
    expect(body).toContain('存量')
  })

  test('蒸馏过就逐场列出来，并关掉那句警告', () => {
    const s = buildSections(
      ctxOf({ sessions: { '/x/a.jsonl': { path: '/x/a.jsonl', size: 1, mtimeMs: 1, lines: 0, lastProcessedAt: '2026-10-12T03:00:00.000Z', cardsEmitted: [] } } }),
      [],
      META.start,
      META.end,
    )
    const body = renderReport(s, META)
    expect(body).not.toContain('这一周没有蒸馏过任何会话')
    expect(body).toContain('蒸馏过 **1** 场会话')
    expect(body).toContain('a')
  })

  test('窗口里没卡时说「更可能是 distill 没跑」，不是「你不够努力」', () => {
    const body = renderReport(buildSections(ctxOf({}), [], META.start, META.end), META)
    expect(body).toContain('distill 没跑')
  })

  test('★ 花的钱是 0 也要说清是「没调用过」而不是缺数据', () => {
    const body = renderReport(buildSections(ctxOf({}), [], META.start, META.end), META)
    expect(body).toContain('$0.0000')
    expect(body).toContain('这一节是 0 不是缺数据')
  })

  test('结尾承认这份报表没调模型 —— 别让人以为有个 AI 读过了', () => {
    const body = renderReport(buildSections(ctxOf({}), [], META.start, META.end), META)
    expect(body).toContain('没有调用任何模型')
  })

  test('已确认 / 待认领分开数 —— ✓ 有几个才是这份报表的价值', () => {
    const yes = card({ id: 'kb-pitfall-y', status: 'confirmed' })
    const no = card({ id: 'kb-pitfall-n', status: 'inbox', mine: '' })
    const body = renderReport(buildSections(ctxOf({}), [yes, no], META.start, META.end), META)
    expect(body).toContain('已确认 1')
    expect(body).toContain('待认领 1')
    expect(body).toContain('- ✓ **')
    expect(body).toContain('- · **')
  })

  test('反复踩的那一节带上每个会话和证据路径', () => {
    const a = card({ id: 'kb-pitfall-1', title: '同一个坑', source: { tool: 't', session: 'sess-aaaa1111', cwd: '/p', date: '2026-10-10' } })
    const b = card({ id: 'kb-pitfall-2', title: '同一个坑', source: { tool: 't', session: 'sess-bbbb2222', cwd: '/p', date: '2026-10-11' } })
    const body = renderReport(buildSections(ctxOf({}), [a, b], META.start, META.end), META)
    expect(body).toContain('### 2 次：同一个坑')
    expect(body).toContain('/p/src/db.ts:12')
    expect(body).toContain('值得的不是「记住它」，是改掉让它发生的那一步')
  })

  test('躺太久的卡被单独点出来', () => {
    const stale = card({ id: 'kb-pitfall-stale', mine: '', title: '躺了很久', source: { tool: 't', session: 's', cwd: '/p', date: '2026-09-01' } })
    const body = renderReport(buildSections(ctxOf({}), [stale], META.start, META.end), META)
    expect(body).toContain('躺了 7 天以上')
    expect(body).toContain('你自己当时也没想清楚')
  })

  test('可回写的规则给出 --check / --yes 两条命令', () => {
    const r = card({ source: { tool: 't', session: 's', cwd: '/proj/a', date: '2026-10-14' } })
    const body = renderReport(buildSections(ctxOf({}), [r], META.start, META.end), META)
    expect(body).toContain('coach rule apply --cwd /proj/a --check')
    expect(body).toContain('coach rule apply --cwd /proj/a --yes')
  })

  test('同一份输入渲染两遍逐字节相同（定时那份靠它判「未变」）', () => {
    const s = buildSections(ctxOf({}), [card()], META.start, META.end)
    expect(renderReport(s, META)).toBe(renderReport(s, META))
  })
})
