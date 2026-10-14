// 复习排期。
//
// 这个文件要钉住两件事：阶梯算得对（尤其封顶和归零这两个边界），
// 以及**写进去之后真的能驱动两个消费者** —— 排期是这三条腿里唯一
// 会改变「明天打开工具看到什么」的一条，所以端到端那几条比纯函数更值钱。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { Card, CardReview, CardSource } from '../src/core/card.ts'
import { newCard, parseCard } from '../src/core/card.ts'
import { findCard, setMine, setStatus, upsertCard } from '../src/core/kb.ts'
import { bootstrapDue, isDue, isScheduledDue, isoDay, nextReview, parseRecall } from '../src/core/review.ts'

const ROOT = join(import.meta.dir, '..')
const CLI = join(ROOT, 'src', 'cli.ts')
const NOW = new Date('2026-10-14T00:00:00Z')
const DAY_MS = 86_400_000

const SOURCE: CardSource = {
  tool: 'claude-code',
  session: 'sess-1',
  cwd: '/tmp/some-repo',
  date: '2026-10-14',
}

function card(over: Partial<Card> = {}): Card {
  return {
    ...newCard({
      type: 'pitfall',
      title: 'Edit 之前先读文件',
      sessionKey: 'claude-code:sess-1',
      turnIndex: 7,
      kind: 'repeat_edit',
      why: '',
      evidence: ['src/auth.ts:88'],
      tags: ['typescript'],
      source: SOURCE,
      confidence: 0.7,
    }),
    ...over,
  }
}

/** 一张卡排到了哪天，就按它自己记的 last 往后推，避免测试跨 UTC 午夜时抖。 */
function addDays(day: string, n: number): string {
  return isoDay(new Date(new Date(`${day}T00:00:00Z`).getTime() + n * DAY_MS))
}

describe('parseRecall', () => {
  test('三个档的中文与英文都认', () => {
    expect(parseRecall('稳了')).toBe('solid')
    expect(parseRecall('solid')).toBe('solid')
    expect(parseRecall('模糊')).toBe('fuzzy')
    expect(parseRecall('fuzzy')).toBe('fuzzy')
    expect(parseRecall('没想起来')).toBe('forgot')
    expect(parseRecall('forgot')).toBe('forgot')
  })

  test('前后空格、大小写都不影响', () => {
    expect(parseRecall(' 稳了 ')).toBe('solid')
    expect(parseRecall('SOLID')).toBe('solid')
  })

  // 「没想起来」多收两个同义词是有意的：被拒绝代价最大的那一刻，
  // 正是用户承认自己没想起来的时候。
  test('承认没想起来时的几种说法都放行', () => {
    expect(parseRecall('想不起来')).toBe('forgot')
    expect(parseRecall('忘了')).toBe('forgot')
  })

  test('认不出来返回 null，绝不猜', () => {
    for (const raw of ['差不多', '', '稳', '忘了点', 'ok']) {
      expect(parseRecall(raw), raw).toBeNull()
    }
  })
})

describe('nextReview 的阶梯', () => {
  test('「稳了」逐档:7 14 30 60 120', () => {
    const rungs: Array<[number, string]> = [
      [0, '2026-10-21'],
      [1, '2026-10-28'],
      [2, '2026-11-13'],
      [3, '2026-12-13'],
      [4, '2027-02-11'],
    ]
    for (const [count, next] of rungs) {
      const r = nextReview({ count }, 'solid', NOW)
      expect({ count: r.count, next: r.next }, `count=${count}`).toEqual({ count: count + 1, next })
    }
  })

  test('第 5 次起间隔封顶 120 天，但次数继续涨', () => {
    for (const count of [5, 7]) {
      const r = nextReview({ count }, 'solid', NOW)
      expect(r.next, `count=${count}`).toBe('2027-02-11')
      expect(r.count, `count=${count}`).toBe(count + 1)
    }
  })

  test('「模糊」不改次数，3 天后再来', () => {
    const r = nextReview({ count: 3 }, 'fuzzy', NOW)
    expect(r).toEqual({ count: 3, last: '2026-10-14', next: '2026-10-17' })
  })

  test('「没想起来」把次数归零，明天再来', () => {
    const r = nextReview({ count: 4 }, 'forgot', NOW)
    expect(r).toEqual({ count: 0, last: '2026-10-14', next: '2026-10-15' })
  })

  test('三档都写下今天这个 last', () => {
    for (const grade of ['solid', 'fuzzy', 'forgot'] as const) {
      expect(nextReview({ count: 1 }, grade, NOW).last).toBe('2026-10-14')
    }
  })

  test('跨年算得对', () => {
    expect(nextReview({ count: 0 }, 'forgot', new Date('2026-12-31T00:00:00Z')).next).toBe('2027-01-01')
    expect(nextReview({ count: 0 }, 'solid', new Date('2026-12-31T00:00:00Z')).next).toBe('2027-01-07')
  })

  test('不改入参 —— 调用方手里的那张卡不该被顺手改掉', () => {
    const prev: CardReview = { count: 2, last: '2026-01-01', next: '2026-02-01' }
    const before = { ...prev }
    nextReview(prev, 'solid', NOW)
    nextReview(prev, 'forgot', NOW)
    expect(prev).toEqual(before)
  })
})

describe('到期判定', () => {
  const base = card({ status: 'confirmed', mine: '先读再改。' })

  test('isScheduledDue:排期到了才算，且必须已确认', () => {
    expect(isScheduledDue({ ...base, review: { count: 1, next: '2026-10-13' } }, NOW)).toBe(true)
    expect(isScheduledDue({ ...base, review: { count: 1, next: '2026-10-14' } }, NOW)).toBe(true)
    expect(isScheduledDue({ ...base, review: { count: 1, next: '2026-10-15' } }, NOW)).toBe(false)
    expect(isScheduledDue({ ...base, review: { count: 1 } }, NOW)).toBe(false)
    // 没认领的卡不谈到期 —— 哪怕排期早就过了
    expect(isScheduledDue({ ...base, status: 'inbox', review: { count: 1, next: '2020-01-01' } }, NOW)).toBe(false)
  })

  test('bootstrapDue:从没排过、落卡满 7 天', () => {
    expect(bootstrapDue({ ...base, source: { ...SOURCE, date: '2026-10-06' } }, NOW)).toBe(true)
    expect(bootstrapDue({ ...base, source: { ...SOURCE, date: '2026-10-08' } }, NOW)).toBe(false)
    expect(bootstrapDue({ ...base, source: { ...SOURCE, date: '' } }, NOW)).toBe(false)
    expect(bootstrapDue({ ...base, status: 'inbox', source: { ...SOURCE, date: '2026-01-01' } }, NOW)).toBe(false)
  })

  // ★ 这条是整个功能的核心修复。
  //   一张 10 天前落的卡刚定了「稳了」（下次 7 天后），如果兜底规则还按
  //   落卡日期算，它明天就又被算成到期 —— 那正是「复习过的卡永远到期」。
  test('排过期之后，兜底规则必须让位 —— 否则刚复习完的卡立刻又到期', () => {
    const old = card({ status: 'confirmed', mine: '先读再改。', source: { ...SOURCE, date: '2026-10-04' } })
    const graded = { ...old, review: { count: 1, last: '2026-10-14', next: '2026-10-21' } }
    expect(isDue(old, NOW)).toBe(true) // 没定过档 → 兜底把它捞进来（引导第一次复习）
    expect(isDue(graded, NOW)).toBe(false) // 定过档 → 听排期的
  })

  test('isDue 是两者的并', () => {
    expect(isDue({ ...base, review: { count: 1, next: '2026-10-13' } }, NOW)).toBe(true)
    expect(isDue({ ...base, source: { ...SOURCE, date: '2026-10-06' } }, NOW)).toBe(true)
    expect(isDue({ ...base, source: { ...SOURCE, date: '2026-10-13' } }, NOW)).toBe(false)
  })
})

describe('coach kb --reviewed(真跑)', () => {
  let kb = ''
  const run = (...argv: string[]) => spawnSync('bun', [CLI, 'kb', '--kb', kb, ...argv], { encoding: 'utf8' })

  function seed(over: Partial<Card> = {}): Card {
    const c = card(over)
    upsertCard(kb, c)
    setMine(kb, c.id, '我原来以为改完再跑，其实要先读。')
    setStatus(kb, c.id, 'confirmed')
    return c
  }
  const readCard = (c: Card): Card => parseCard(readFileSync(pathOf(c), 'utf8')) as Card
  const pathOf = (c: Card): string => {
    const found = findCard(kb, c.id)
    if (found === null) throw new Error(`卡不见了: ${c.id}`)
    return found.path
  }

  beforeEach(() => {
    kb = mkdtempSync(join(tmpdir(), 'coach-review-'))
  })
  afterEach(() => {
    rmSync(kb, { recursive: true, force: true })
  })

  test('记一次「稳了」:写进三个字段，并让 index.md 的到期区有据可依', () => {
    const c = seed()
    const r = run('--reviewed', c.id, '--recall', '稳了')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('下次复习')

    const back = readCard(c)
    expect(back.review.count).toBe(1)
    expect(back.review.next).toBe(addDays(back.review.last as string, 7))
    expect(r.stdout).toContain(back.review.next as string)
    // 用户自己那句话一个字节都没动
    expect(back.mine).toBe('我原来以为改完再跑，其实要先读。')
    // writeIndex 被调过,否则索引是死的
    expect(readFileSync(join(kb, 'index.md'), 'utf8')).toContain('我的知识库')
  })

  test('「没想起来」归零并让卡从到期列表里消失', () => {
    const c = seed()
    run('--reviewed', c.id, '--recall', '稳了')
    const r = run('--reviewed', c.id, '--recall', '没想起来')
    expect(r.status).toBe(0)
    const back = readCard(c)
    expect(back.review.count).toBe(0)
    expect(back.review.next).toBe(addDays(back.review.last as string, 1))
    // 排期在未来 → 明天之前都不该再出现在 --due 里
    expect(run('--due').stdout).toContain('今天没有到期该复习的卡')
  })

  test('不认识的档位是用法错(2)，卡片不动', () => {
    const c = seed()
    const before = readFileSync(pathOf(c), 'utf8')
    const r = run('--reviewed', c.id, '--recall', '差不多')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('不认识的')
    expect(readFileSync(pathOf(c), 'utf8')).toBe(before)
  })

  test('缺 --recall 是用法错(2)', () => {
    const c = seed()
    expect(run('--reviewed', c.id).status).toBe(2)
  })

  // 裸 --reviewed 的 get() 是 undefined —— 不做 given() 判断的话,
  // 它会静默掉进关键词搜索分支,打出一句莫名其妙的「没有匹配「」的卡」。
  test('裸 --reviewed 报用法错，而不是掉进搜索', () => {
    const r = run('--reviewed')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--reviewed 后面要跟卡片 id')
  })

  test('没确认的卡不给记(1) —— 提示指向 save', () => {
    const c = card()
    upsertCard(kb, c)
    const r = run('--reviewed', c.id, '--recall', '稳了')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('confirm')
  })
})
