import { describe, expect, test } from 'bun:test'
import {
  MINE_PLACEHOLDER,
  SECTION_AI,
  SECTION_MINE,
  SECTION_TRANSFER,
  fileNameOf,
  hasMine,
  isThinMine,
  newCard,
  parseCard,
  readSection,
  renderCard,
  replaceSection,
} from '../src/core/card.ts'
import type { Card, CardSource } from '../src/core/card.ts'

const SOURCE: CardSource = {
  tool: 'claude-code',
  session: 'aebd09c8',
  cwd: '/Users/lingaibo/workspace/some-repo',
  branch: 'feat/auth',
  date: '2026-10-14',
}

function sample(over: Partial<Card> = {}): Card {
  return {
    ...newCard({
      type: 'pitfall',
      title: 'Edit 之前先读一遍文件',
      sessionKey: 'claude-code:aebd09c8',
      turnIndex: 42,
      kind: 'repeat_edit',
      why: '同一个文件改了四次',
      evidence: ['src/auth.ts:88', 'npm test → TS2307'],
      tags: ['typescript', 'edit'],
      source: SOURCE,
      confidence: 0.7,
    }),
    ...over,
  }
}

describe('round-trip', () => {
  test('render → parse 拿回等价的卡', () => {
    const card = sample({ mine: '我原来以为改完再跑，其实要先读。', ai: '因为 Edit 是字符串替换。', transfer: '先 Read 再看 Edit。' })
    const back = parseCard(renderCard(card))
    expect(back).not.toBeNull()
    const b = back as Card
    expect(b.id).toBe(card.id)
    expect(b.title).toBe(card.title)
    expect(b.type).toBe(card.type)
    expect(b.tags).toEqual(card.tags)
    expect(b.mine).toBe(card.mine)
    expect(b.ai).toBe(card.ai)
    expect(b.transfer).toBe(card.transfer)
    expect(b.evidence).toEqual(card.evidence)
    expect(b.source).toEqual(card.source)
    expect(b.status).toBe('inbox')
  })

  test('再 render 一次字节不变（写盘幂等的地基）', () => {
    const card = sample({ mine: '一句话' })
    const once = renderCard(card)
    const twice = renderCard(parseCard(once) as Card)
    expect(twice).toBe(once)
  })

  // review 三个字段以前没有任何写入方，所以这段往返一直没人测。
  // 排期接上之后它是活的，得钉住：count 恒定发射，last/next 没值时不发射。
  test('review 往返稳定，且 count 0 时不写 last/next', () => {
    const graded = sample({ review: { count: 3, last: '2026-10-01', next: '2026-10-21' } })
    const once = renderCard(graded)
    expect(once).toContain('review_count: 3')
    expect(once).toContain('review_last: 2026-10-01')
    expect(once).toContain('review_next: 2026-10-21')
    const back = parseCard(once) as Card
    expect(back.review).toEqual({ count: 3, last: '2026-10-01', next: '2026-10-21' })
    expect(renderCard(back)).toBe(once)

    const bare = renderCard(sample())
    expect(bare).toContain('review_count: 0')
    expect(bare).not.toContain('review_last')
    expect(bare).not.toContain('review_next')
  })

  test('标题里的引号与冒号不会破坏 frontmatter', () => {
    const card = sample({ title: '报错: "unexpected token" 的三种成因' })
    const back = parseCard(renderCard(card)) as Card
    expect(back.title).toBe(card.title)
    expect(back.id).toBe(card.id)
  })

  test('没有分支的会话不写 branch 行', () => {
    const card = sample({ source: { ...SOURCE, branch: undefined } })
    expect(renderCard(card)).not.toContain('branch:')
    expect((parseCard(renderCard(card)) as Card).source.branch).toBeUndefined()
  })
})

describe('「我自己的表述」是这套东西的立身之本', () => {
  test('新卡一律留空，哪怕信号本身就是用户原话', () => {
    expect(sample().mine).toBe('')
    expect(renderCard(sample())).toContain(MINE_PLACEHOLDER)
  })

  test('占位符不算「写过了」', () => {
    expect(hasMine(renderCard(sample()))).toBe(false)
  })

  test('短不等于没写 —— 用户写下的每个字都不许丢', () => {
    // 这条曾经是 bug：长度门槛被拿来判断「是不是占位符」，于是
    // 「一句话」这种三字答案会在下次读取时被静默抹成空。
    for (const words of ['嗯', '别猜', '一句话', '先读再改']) {
      const md = renderCard(sample({ mine: words }))
      expect(hasMine(md)).toBe(true)
      expect((parseCard(md) as Card).mine).toBe(words)
    }
  })

  test('太短的只提示、不删', () => {
    expect(isThinMine(renderCard(sample({ mine: '嗯' })))).toBe(true)
    expect(isThinMine(renderCard(sample({ mine: '原来要先读文件' })))).toBe(false)
    expect(isThinMine(renderCard(sample()))).toBe(false) // 占位符不算「写了但太短」
  })

  test('回写到文件后 parse 能读回来', () => {
    const card = sample()
    const md = replaceSection(renderCard(card), SECTION_MINE, '先读再改,别猜。')
    const back = parseCard(md) as Card
    expect(back.mine).toBe('先读再改,别猜。')
    expect(hasMine(md)).toBe(true)
  })
})

describe('replaceSection', () => {
  test('只动目标节，兄弟节字节不变', () => {
    const card = sample({ mine: '原始的一句话', ai: '原来的解释', transfer: '原来的第一步' })
    const before = renderCard(card)
    const after = replaceSection(before, SECTION_AI, '新的解释')
    expect(readSection(after, SECTION_AI)).toBe('新的解释')
    expect(readSection(after, SECTION_MINE)).toBe('原始的一句话')
    expect(readSection(after, SECTION_TRANSFER)).toBe('原来的第一步')
  })

  test('替换多次不会长出多余空行', () => {
    let md = renderCard(sample({ ai: 'x' }))
    for (let i = 0; i < 5; i += 1) md = replaceSection(md, SECTION_AI, `第 ${i} 版`)
    expect(md).not.toMatch(/\n{4,}/)
    expect(readSection(md, SECTION_AI)).toBe('第 4 版')
  })

  test('目标节不存在时追加到末尾', () => {
    const md = replaceSection('---\nid: x\n---\n\n# T\n', SECTION_TRANSFER, '下一步')
    expect(readSection(md, SECTION_TRANSFER)).toBe('下一步')
  })

  test('找不到的节读出空串', () => {
    expect(readSection('# 只有标题\n', SECTION_MINE)).toBe('')
  })
})

describe('parseCard 的容错', () => {
  test('不是我们的文件返回 null', () => {
    expect(parseCard('# 随便一个 md\n')).toBeNull()
    expect(parseCard('')).toBeNull()
  })

  test('frontmatter 没闭合返回 null', () => {
    expect(parseCard('---\nid: kb-pitfall-abc123\n')).toBeNull()
  })

  test('没有 id 返回 null', () => {
    expect(parseCard('---\ntitle: x\n---\n\n# x\n')).toBeNull()
  })

  test('未知 type 落到 pitfall，不让整张卡废掉', () => {
    const md = '---\nid: kb-x-abc123\ntype: 乱七八糟\n---\n\n# T\n'
    expect((parseCard(md) as Card).type).toBe('pitfall')
  })

  test('坏的 tags 退化成空数组', () => {
    const md = '---\nid: kb-x-abc123\ntags: 不是数组\n---\n\n# T\n'
    expect((parseCard(md) as Card).tags).toEqual([])
  })
})

describe('fileNameOf', () => {
  test('id 在前、slug 在后，能被 idFromFileName 认出来', () => {
    expect(fileNameOf(sample())).toMatch(/^kb-pitfall-[0-9a-f]{6}-edit-.*\.md$/)
  })
})
