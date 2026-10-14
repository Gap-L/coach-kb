import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Card } from '../src/core/card.ts'
import { renderRuleBlock, pickRules, renderRulesFile, ruleLine, rulesPath, targetsFor } from '../src/commands/rule.ts'

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
    transfer: '先 curl 一下本地端口，再去看代码。',
    links: [],
    signals: [],
    source: { tool: 'claude-code', session: 's1', cwd: '/p', date: '2026-10-14' },
    review: { count: 0 },
    ...over,
  }
}

describe('pickRules 的三道门槛', () => {
  test('没确认过的卡不许进项目文件', () => {
    // 这一条是整条链最重要的一道闸：把 AI 摘要写进每次会话都加载的文件，
    // 正是这个项目最想避免的事。
    expect(pickRules([card({ status: 'inbox' })])).toEqual([])
  })

  test('说不出「下一步」的卡不许进 —— transfer 与 mine 都空就不出规则', () => {
    expect(pickRules([card({ transfer: '', mine: '' })])).toEqual([])
  })

  test('transfer 优先，没有才退回 mine', () => {
    const both = pickRules([card({ transfer: '先看日志。', mine: '我原来以为是网络。' })])
    expect(both[0]?.line).toContain('先看日志')
    expect(both[0]?.line).not.toContain('我原来以为')
    const onlyMine = pickRules([card({ transfer: '', mine: '我原来以为是网络，其实是本地服务没起。' })])
    expect(onlyMine[0]?.line).toContain('其实是本地服务没起')
  })

  test('★ 绝不拿 ai 那一节凑数', () => {
    // ai 是 AI 的散文。写进 CLAUDE.md 就变成 AI 在给未来的你下指令。
    const r = pickRules([card({ transfer: '', mine: '', ai: '这是因为连接池没配。' })])
    expect(r).toEqual([])
  })

  test('--cwd 过滤：别的项目的规则不许串过去', () => {
    const a = card({ id: 'kb-pitfall-a', source: { tool: 't', session: 's1', cwd: '/proj/a', date: '2026-10-14' } })
    const b = card({ id: 'kb-pitfall-b', source: { tool: 't', session: 's2', cwd: '/proj/b', date: '2026-10-14' } })
    expect(pickRules([a, b], { cwd: '/proj/a' }).map(r => r.cardId)).toEqual(['kb-pitfall-a'])
    expect(pickRules([a, b]).length).toBe(2)
  })

  test('cwd 先 resolve 再比 —— `/p/../p` 与 `/p` 是同一个项目', () => {
    const c = card({ source: { tool: 't', session: 's', cwd: '/proj/a', date: '2026-10-14' } })
    expect(pickRules([c], { cwd: '/proj/../proj/a' }).length).toBe(1)
  })

  test('反复踩的排前面（跨会话次数降序）', () => {
    const once = card({ id: 'kb-pitfall-once', title: '只踩过一次', source: { tool: 't', session: 's1', cwd: '/p', date: '2026-10-14' } })
    const twice1 = card({ id: 'kb-pitfall-t1', title: '踩过两次', source: { tool: 't', session: 's1', cwd: '/p', date: '2026-10-14' } })
    const twice2 = card({ id: 'kb-pitfall-t2', title: '踩过两次', source: { tool: 't', session: 's2', cwd: '/p', date: '2026-10-14' } })
    const r = pickRules([once, twice1, twice2])
    // 次数按**标题**数会话：同一签名必得同一标题，所以这个归组是确定性的
    expect(r.map(x => x.sessions)).toEqual([2, 2, 1])
    expect(r[0]?.title).toBe('踩过两次')
    expect(r[2]?.title).toBe('只踩过一次')
  })

  test('max 封顶 —— CLAUDE.md 每次会话都进上下文，块头长了就是在收税', () => {
    const many = Array.from({ length: 20 }, (_, i) => card({ id: `kb-pitfall-${i}`, title: `坑 ${i}` }))
    expect(pickRules(many).length).toBe(8)
    expect(pickRules(many, { max: 3 }).length).toBe(3)
  })
})

describe('ruleLine', () => {
  test('取第一句，不整段搬', () => {
    const line = ruleLine(card({ transfer: '先 curl 一下。然后再去看代码，因为日志里什么都没有。' }))
    expect(line).toContain('先 curl 一下。')
    expect(line).not.toContain('再去看代码')
  })

  test('全角句号也切', () => {
    expect(ruleLine(card({ transfer: '先看一眼日志再动手。后面还有一句不该出现。' }))).not.toContain('不该出现')
  })

  test('第一句短于 8 个字就不切 —— 切出「先看。」这种片段比长一行更糟', () => {
    // `. {8,}?` 这个下限是刻意的，不是漏写。一条说不出动作的规则写进
    // CLAUDE.md 只是噪音，所以宁可往后并一句。
    expect(ruleLine(card({ transfer: '先看。后面还有一句。' }))).toContain('后面还有一句')
  })

  test('超过 100 字的「下一步」截断并留省略号', () => {
    const long = '先' + '很长的说明'.repeat(40) + '。'
    const line = ruleLine(card({ transfer: long }))
    // 上限只管「下一步」那一段；标题是带出来给人认的，不参与截断
    expect(line).toEndWith('…')
    expect(line.length).toBeLessThanOrEqual('反复踩的坑：ECONNREFUSED —— '.length + 100)
  })

  test('标题带出来 —— 半年后你只看得懂标题', () => {
    expect(ruleLine(card({ title: '反复改 auth.ts' }))).toStartWith('反复改 auth.ts —— ')
  })
})

describe('renderRulesFile', () => {
  test('按项目分组，没 cwd 的垫底', () => {
    const withCwd = card({ id: 'kb-pitfall-w', source: { tool: 't', session: 's', cwd: '/proj/a', date: '2026-10-14' } })
    const noCwd = card({ id: 'kb-pitfall-n', source: { tool: 't', session: 's', cwd: '', date: '2026-10-14' } })
    const body = renderRulesFile(pickRules([withCwd, noCwd]), '2026-10-14')
    expect(body.indexOf('## /proj/a')).toBeLessThan(body.indexOf('## (卡片里没记项目目录)'))
    // 每行都带卡片 id，否则「这条哪来的」只能靠猜
    expect(body).toContain('`kb-pitfall-w`')
  })

  test('空列表时说的是「空着是正常的」，不是「你做得不够」', () => {
    const body = renderRulesFile([], '2026-10-14')
    expect(body).toContain('空着是正常的')
    expect(body).not.toContain('##')
  })
})

describe('renderRuleBlock', () => {
  test('短，且每条都指回卡片 id', () => {
    const block = renderRuleBlock(pickRules([card()]))
    expect(block.split('\n').length).toBeLessThan(12)
    expect(block).toContain('`kb-pitfall-aaaaaa`')
    expect(block).toContain('coach kb --show <id>')
  })
})

describe('targetsFor', () => {
  test('只写已经存在的那个文件 —— 不给别人仓库凭空塞 AGENTS.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coach-rule-'))
    try {
      expect(targetsFor(dir)).toEqual([join(dir, 'CLAUDE.md')]) // 都不在才新建
      writeFileSync(join(dir, 'AGENTS.md'), '# a\n')
      expect(targetsFor(dir)).toEqual([join(dir, 'AGENTS.md')]) // 只有它就用它
      writeFileSync(join(dir, 'CLAUDE.md'), '# c\n')
      expect(targetsFor(dir).length).toBe(2) // 双工具的项目，两边都写
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('--file 指谁就写谁', () => {
    expect(targetsFor('/p', '/p/OTHER.md')).toEqual(['/p/OTHER.md'])
  })
})

// ---------------------------------------------------------------------------
// 这一段是回归测试：一次真实的误伤
// ---------------------------------------------------------------------------

describe('★ propose 落点不能被别的项目盖掉', () => {
  test('带 --cwd 时文件按项目分开，不带时才是那一份汇总', () => {
    // 出过一次真事：`propose --cwd B` 把 `propose --cwd A` 刚写的那份整份盖了，
    // 而那份正是用户刚要看的。坏法是静的 —— 文件看着好好的，内容换人了。
    // 这里断言的是**路径不同**，因为不同路径是不会互相覆盖的唯一保证。
    const ctx = { paths: { inbox: '/kb/inbox' } } as unknown as Parameters<typeof rulesPath>[0]
    const a = rulesPath(ctx, '2026-10-14', '/proj/a')
    const b = rulesPath(ctx, '2026-10-14', '/proj/b')
    const none = rulesPath(ctx, '2026-10-14', undefined)
    expect(a).not.toBe(b)
    expect(a).not.toBe(none)
    expect(none).toBe('/kb/inbox/rules-2026-10-14.md')
    expect(a).toBe('/kb/inbox/rules-2026-10-14-proj-a.md')
  })

  test('同一个项目同一天重跑仍然是同一个文件（幂等不靠改名）', () => {
    const ctx = { paths: { inbox: '/kb/inbox' } } as unknown as Parameters<typeof rulesPath>[0]
    expect(rulesPath(ctx, '2026-10-14', '/proj/a')).toBe(rulesPath(ctx, '2026-10-14', '/proj/../proj/a'))
  })
})

describe('已落盘的规则文件确实被写出来（端到端的一小步）', () => {
  test('写进小写 slug 的文件名，且内容含规则行', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coach-rulefile-'))
    try {
      const ctx = { paths: { inbox: dir } } as unknown as Parameters<typeof rulesPath>[0]
      const p = rulesPath(ctx, '2026-10-14', '/Users/me/My Project')
      writeFileSync(p, renderRulesFile(pickRules([card()]), '2026-10-14'))
      expect(p.endsWith('rules-2026-10-14-users-me-my-project.md')).toBe(true)
      expect(readFileSync(p, 'utf8')).toContain('kb-pitfall-aaaaaa')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
