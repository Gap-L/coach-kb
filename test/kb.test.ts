import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Card, CardSource } from '../src/core/card.ts'
import { SECTION_MINE, newCard, parseCard, readSection, renderCard } from '../src/core/card.ts'
import { findCard, judgeDuplicate, loadCards, renderIndex, setMine, setReview, setStatus, upsertCard, writeIndex } from '../src/core/kb.ts'
import { isDue } from '../src/core/review.ts'
import { kbPaths } from '../src/core/paths.ts'

let KB = ''
const SOURCE: CardSource = {
  tool: 'claude-code',
  session: 'sess-1',
  cwd: '/Users/lingaibo/workspace/some-repo',
  branch: 'main',
  date: '2026-10-14',
}

beforeEach(() => {
  KB = mkdtempSync(join(tmpdir(), 'coach-kb-test-'))
})
afterEach(() => {
  rmSync(KB, { recursive: true, force: true })
})

function card(over: Partial<Card> = {}, input: Partial<Parameters<typeof newCard>[0]> = {}): Card {
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
      ...input,
    }),
    ...over,
  }
}

function allFiles(): string[] {
  const p = kbPaths(KB)
  const out: string[] = []
  for (const dir of [p.concepts, p.patterns, p.pitfalls, p.playbooks, p.inbox]) {
    for (const f of readdirSync(dir)) out.push(join(dir, f))
  }
  return out.sort()
}

function snapshot(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of allFiles()) out[f] = readFileSync(f, 'utf8')
  return out
}

describe('upsertCard', () => {
  test('新卡落在对应的 type 目录里，status 是 inbox', () => {
    const r = upsertCard(KB, card())
    expect(r.created).toBe(true)
    expect(r.path).toContain('/cards/pitfalls/')
    expect((parseCard(readFileSync(r.path, 'utf8')) as Card).status).toBe('inbox')
  })

  test('同 id 再写一次：不新建文件', () => {
    const first = upsertCard(KB, card())
    const second = upsertCard(KB, card())
    expect(second.created).toBe(false)
    expect(second.path).toBe(first.path)
    expect(allFiles()).toHaveLength(1)
  })

  // ★ 整个项目最重要的性质。
  test('整场会话重跑十遍，知识库字节不变', () => {
    upsertCard(KB, card())
    const after1 = snapshot()
    for (let i = 0; i < 9; i += 1) upsertCard(KB, card())
    expect(snapshot()).toEqual(after1)
  })

  test('重跑时二次 upsert 报 changed=false，不产生多余写盘', () => {
    upsertCard(KB, card())
    expect(upsertCard(KB, card()).changed).toBe(false)
  })

  test('新证据并进来，旧的不丢', () => {
    const first = upsertCard(KB, card())
    upsertCard(KB, card({ evidence: ['scripts/build.mjs:12'] }))
    const md = readFileSync(first.path, 'utf8')
    expect(md).toContain('src/auth.ts:88')
    expect(md).toContain('scripts/build.mjs:12')
  })

  test('AI 补充只填空，不覆盖已写的', () => {
    upsertCard(KB, card({ ai: '第一版解释' }))
    upsertCard(KB, card({ ai: '第二版解释' }))
    const found = loadCards(KB)[0] as { card: Card }
    expect(found.card.ai).toBe('第一版解释')
  })
})

describe('upsert 永远不碰「我自己的表述」', () => {
  test('用户写过之后，任何自动更新都保留它', () => {
    const r = upsertCard(KB, card())
    setMine(KB, card().id, '我原来以为改完再跑，其实要先读。')

    // 模拟一周后同一张卡被新证据、新解释、新转移句更新
    upsertCard(KB, card({ ai: '新的解释', transfer: '新的第一步', evidence: ['src/auth.ts:88', 'x.ts:1'] }))
    upsertCard(KB, card({ ai: '又一版' }))

    const md = readFileSync(r.path, 'utf8')
    expect((parseCard(md) as Card).mine).toBe('我原来以为改完再跑，其实要先读。')
    expect(md).toContain('新的第一步')
  })

  test('setMine 同步 frontmatter 的 mine 字段', () => {
    const r = upsertCard(KB, card())
    expect(readFileSync(r.path, 'utf8')).toMatch(/^mine: false$/m)
    setMine(KB, card().id, '我原来以为改完再跑，其实要先读。')
    expect(readFileSync(r.path, 'utf8')).toMatch(/^mine: true$/m)
  })

  test('setMine 对不存在的 id 报错而不是建卡', () => {
    const r = setMine(KB, 'kb-pitfall-000000', '一句话')
    expect(r.ok).toBe(false)
    expect(allFiles()).toHaveLength(0)
  })
})

// 实测踩到的:证据里只要有一个反引号,每跑一次 distill 就多复制一条。
// 渲染时反引号被换成单引号,读回来就和内存里的原串对不上,朴素的 Set 并集
// 于是把同一条证据留了两份 —— 第三跑就三份。知识库会悄悄长胖,而没人报错。
describe('upsert 的证据并集必须幂等（反引号往返）', () => {
  // 第一段**必须**带反引号 —— 不带的话渲染时不会有替换，往返天然稳定，
  // 这条测试就测不到东西了（实测确认过：不带反引号时旧逻辑也能过）。
  const EVIDENCE = ['`~/.claude/coach/notes/` 至今为空', 'src/a.ts:88']

  test('连跑三次，证据数量不变，也不再改写文件', () => {
    const c = card({ evidence: EVIDENCE })
    const r = upsertCard(KB, c)
    const first = readFileSync(r.path, 'utf8')

    const second = upsertCard(KB, card({ evidence: EVIDENCE }))
    const third = upsertCard(KB, card({ evidence: EVIDENCE }))

    expect(second.changed).toBe(false)
    expect(third.changed).toBe(false)
    expect(readFileSync(r.path, 'utf8')).toBe(first)
    expect((parseCard(first) as Card).evidence).toHaveLength(EVIDENCE.length)
  })

  test('带反引号的证据落盘后不再有反引号', () => {
    const r = upsertCard(KB, card({ evidence: ['看 `config.toml` 里那段'] }))
    const md = readFileSync(r.path, 'utf8')
    const parsed = parseCard(md) as Card
    expect(parsed.evidence[0]).not.toContain('`')
    // 往返稳定：再写一遍还是一样
    expect(upsertCard(KB, card({ evidence: parsed.evidence })).changed).toBe(false)
  })

  // 旧知识库里已经存在的重复（比如上面那个 bug 落下的），
  // 再跑一次要能收敛，而不是继续叠。
  test('已经写重复的旧卡片能收敛回去', () => {
    const r = upsertCard(KB, card({ evidence: ['带 `反引号` 的一条'] }))
    // 手工模拟旧 bug 的产物：同一条证据出现两次
    const md = readFileSync(r.path, 'utf8')
    writeFileSync(r.path, md.replace('- `带 \'反引号\' 的一条`', "- `带 '反引号' 的一条`\n- `带 '反引号' 的一条`"))

    upsertCard(KB, card({ evidence: ['带 `反引号` 的一条'] }))
    const after = parseCard(readFileSync(r.path, 'utf8')) as Card
    expect(after.evidence).toHaveLength(1)
  })
})

describe('confirm 的机械闸门', () => {
  test('没写自己的话，confirm 拒绝', () => {
    const c = card()
    upsertCard(KB, c)
    const r = setStatus(KB, c.id, 'confirmed')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('我自己的表述')
  })

  test('写了一句之后才放行', () => {
    const c = card()
    upsertCard(KB, c)
    setMine(KB, c.id, '先读再改。')
    expect(setStatus(KB, c.id, 'confirmed').ok).toBe(true)
    expect(loadCards(KB)[0]?.card.status).toBe('confirmed')
  })

  test('拒绝时状态确实没变', () => {
    const c = card()
    upsertCard(KB, c)
    setStatus(KB, c.id, 'confirmed')
    expect(loadCards(KB)[0]?.card.status).toBe('inbox')
  })
})

describe('setReview', () => {
  const NOW = new Date('2026-10-14T00:00:00Z')

  /** 落一张已确认的卡 —— 复习的前提。 */
  function confirmed(over: Partial<Card> = {}): { card: Card; path: string } {
    const c = card(over)
    const r = upsertCard(KB, c)
    setMine(KB, c.id, '我原来以为改完再跑，其实要先读。')
    setStatus(KB, c.id, 'confirmed')
    return { card: c, path: r.path }
  }

  test('找不到 id 就报错，不建卡', () => {
    const r = setReview(KB, 'kb-pitfall-000000', 'solid', NOW)
    expect(r.ok).toBe(false)
    expect(allFiles()).toHaveLength(0)
  })

  test('闸门:没确认的卡不给记，且文件一个字节不变', () => {
    const c = card()
    const r0 = upsertCard(KB, c)
    const before = readFileSync(r0.path, 'utf8')
    const r = setReview(KB, c.id, 'solid', NOW)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('confirm')
    expect(readFileSync(r0.path, 'utf8')).toBe(before)
  })

  test('写进三个字段，并且用户那句话一个字节不动', () => {
    const { card: c, path } = confirmed()
    const r = setReview(KB, c.id, 'solid', NOW)
    expect(r.ok).toBe(true)
    const md = readFileSync(path, 'utf8')
    expect(md).toMatch(/^review_count: 1$/m)
    expect(md).toMatch(/^review_last: 2026-10-14$/m)
    expect(md).toMatch(/^review_next: 2026-10-21$/m)
    // ★ 这条路径上唯一的写动作只碰 frontmatter；「我自己的表述」逐字节不变。
    expect(readSection(md, SECTION_MINE)).toBe('我原来以为改完再跑，其实要先读。')
    expect((parseCard(md) as Card).mine).toBe('我原来以为改完再跑，其实要先读。')
  })

  // 手写的、或更早版本落下的卡可能连 review_count 这一行都没有。
  // 朴素的 `^review_next: .*$` 替换这时会**静默什么都不做** —— 命令报成功、字段没写进去。
  test('缺行的旧卡:三个字段补在 date 之后，顺序照渲染器', () => {
    const { card: c, path } = confirmed()
    writeFileSync(path, readFileSync(path, 'utf8').replace(/^review_count: .*\n/m, ''))
    expect(readFileSync(path, 'utf8')).not.toContain('review_count')

    expect(setReview(KB, c.id, 'fuzzy', NOW).ok).toBe(true)

    const md = readFileSync(path, 'utf8')
    expect(md).toMatch(/^date: 2026-10-14\nreview_count: 0\nreview_last: 2026-10-14\nreview_next: 2026-10-17\n/m)
    expect((parseCard(md) as Card).mine).toBe('我原来以为改完再跑，其实要先读。')
  })

  test('手写的结果没偏离渲染器:再渲染一次字节不变', () => {
    const { card: c, path } = confirmed()
    setReview(KB, c.id, 'solid', NOW)
    const md = readFileSync(path, 'utf8')
    expect(renderCard(parseCard(md) as Card)).toBe(md)
  })

  // ★ 这里**不能**照抄 setStatus 那套 `next === md → 失败` 的探测器：
  //   同一天连记两次「模糊」三个值完全一样、字节完全相同，
  //   那个探测器会把一次成功报成「改不动」。
  test('同一天连记两次「模糊」:第二次仍然成功，且不动文件', () => {
    const { card: c, path } = confirmed()
    expect(setReview(KB, c.id, 'fuzzy', NOW).ok).toBe(true)
    const once = readFileSync(path, 'utf8')
    expect(setReview(KB, c.id, 'fuzzy', NOW).ok).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(once)
  })

  test('「没想起来」归零，「稳了」再从头爬', () => {
    const { card: c } = confirmed()
    setReview(KB, c.id, 'solid', NOW)
    setReview(KB, c.id, 'solid', NOW)
    expect(setReview(KB, c.id, 'forgot', NOW).review).toEqual({ count: 0, last: '2026-10-14', next: '2026-10-15' })
    expect(setReview(KB, c.id, 'solid', NOW).review).toEqual({ count: 1, last: '2026-10-14', next: '2026-10-21' })
  })
})

describe('findCard / loadCards', () => {
  test('能按 id 找回来', () => {
    const c = card()
    upsertCard(KB, c)
    expect(findCard(KB, c.id)?.card.title).toBe(c.title)
  })

  test('找不到返回 null 而不是抛', () => {
    expect(findCard(KB, 'kb-concept-abcdef')).toBeNull()
  })

  test('手改坏的卡被跳过，不拖垮整库', () => {
    upsertCard(KB, card())
    const p = kbPaths(KB)
    writeFileSync(join(p.pitfalls, 'garbage.md'), '这不是我们的东西\n')
    expect(loadCards(KB)).toHaveLength(1)
  })
})

describe('judgeDuplicate', () => {
  const existing = [
    card({ id: 'kb-pitfall-aaaaaa', title: 'Edit 之前先读文件', tags: ['typescript', 'edit'], evidence: ['src/auth.ts:88'] }),
  ]

  test('八竿子打不着 → new', () => {
    const other = card({
      id: 'kb-concept-bbbbbb',
      title: 'Bun 的 workspaces 怎么用',
      tags: ['bun', 'monorepo'],
      evidence: ['package.json'],
    })
    expect(judgeDuplicate(other, existing).verdict).toBe('new')
  })

  test('几乎同一张 → merge', () => {
    const twin = card({ id: 'kb-pitfall-cccccc', evidence: ['src/auth.ts:88'] })
    const v = judgeDuplicate(twin, existing)
    expect(v.verdict).toBe('merge')
    expect(v.against).toBe('kb-pitfall-aaaaaa')
  })

  test('不跟自己比', () => {
    expect(judgeDuplicate(existing[0] as Card, existing).verdict).toBe('new')
  })

  test('空库 → new', () => {
    expect(judgeDuplicate(card(), []).verdict).toBe('new')
  })
})

describe('index.md', () => {
  const NOW = new Date('2026-10-14T00:00:00Z')

  test('inbox 的卡不进类型视图', () => {
    const idx = renderIndex([card({ title: '待确认的' })], NOW)
    expect(idx).toContain('待确认')
    expect(idx).not.toMatch(/^### pitfall/m)
  })

  test('确认过的卡按类型出现，并标出缺表述的卡', () => {
    const confirmed = card({ id: 'kb-pitfall-aaaaaa', title: '确认过的', status: 'confirmed', mine: '先读再改。' })
    const missing = card({ id: 'kb-pitfall-bbbbbb', title: '没写过的', status: 'confirmed' })
    const idx = renderIndex([confirmed, missing], NOW)
    expect(idx).toContain('### pitfall（2）')
    expect(idx).toContain('kb-pitfall-aaaaaa')
    expect(idx).toContain('⚠️ **1** 张还没写「我自己的表述」')
  })

  test('排期到了的卡出现在「该复习了」', () => {
    const c = card({ id: 'kb-pitfall-aaaaaa', title: '到期了', status: 'confirmed', mine: '先读再改。', review: { count: 1, next: '2026-10-13' } })
    const idx = renderIndex([c], NOW)
    expect(idx).toContain('## 该复习了')
    expect(idx).toContain('kb-pitfall-aaaaaa')
  })

  test('排期还没到的卡不出现', () => {
    const c = card({ id: 'kb-pitfall-aaaaaa', title: '还没到', status: 'confirmed', mine: '先读再改。', review: { count: 1, next: '2026-10-15' } })
    expect(renderIndex([c], NOW)).not.toContain('## 该复习了')
  })

  // ★ 有意的不一致，不是 bug：索引只认排期，**不认**「落卡满 7 天」的兜底。
  //   兜底只属于 `kb --due`（一次交互命令里的提示）。让 index.md 也吃兜底，
  //   等于让一个属于用户的文件在他什么都没做时自己变响 —— 那是 nag。
  //   所以对「从没定过档的老卡」，这两个视图会正当地显示不同的列表。
  test('从没定过档的老卡:索引不列它，但 kb --due 会', () => {
    const old = card({
      id: 'kb-pitfall-bbbbbb',
      title: '从没复习过',
      status: 'confirmed',
      mine: '先读再改。',
      source: { ...SOURCE, date: '2026-09-14' },
    })
    expect(renderIndex([old], NOW)).not.toContain('## 该复习了')
    expect(isDue(old, NOW)).toBe(true)
  })
})

describe('writeIndex', () => {
  test('写盘后 index.md 存在且可读', () => {
    upsertCard(KB, card({ status: 'confirmed', mine: '先读再改。' }))
    const r = writeIndex(KB)
    expect(r.confirmed).toBe(1)
    expect(readFileSync(r.path, 'utf8')).toContain('我的知识库')
  })

  // 这两个数必须分开。原来只返回一个「count」，调用方拿它印
  // 「知识库共 N 张卡」—— 而它其实是已确认数，于是刚落了 3 张骨架卡的库
  // 会显示「共 0 张卡」。inbox 与 confirmed 在这个项目里含义天差地别
  // （AI 写的 vs 你认过的），合成一个数必然误导。
  test('total 与 confirmed 分开报：刚落的骨架卡算 total 不算 confirmed', () => {
    upsertCard(KB, card({ id: 'kb-pitfall-aaaaaa', status: 'inbox' }))
    upsertCard(KB, card({ id: 'kb-pitfall-bbbbbb', status: 'inbox' }))
    upsertCard(KB, card({ id: 'kb-pitfall-cccccc', status: 'confirmed', mine: '我说过的话。' }))
    const r = writeIndex(KB)
    expect(r.total).toBe(3)
    expect(r.confirmed).toBe(1)
  })
})
