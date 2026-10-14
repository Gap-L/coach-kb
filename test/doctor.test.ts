// doctor 的测试。
//
// 这个文件测的主要不是 doctor 的实现,而是**doctor 的那张 canary 表本身灵不灵**。
// 理由:doctor 是唯一一个「它自己说自己没问题」的地方 —— 它的输出是一排 ✓。
// 如果 canary 表被改坏了(比如换了个假密钥,而那个串正好被白名单放行),
// doctor 会**照样打 ✓**,然后用户就以为脱敏是好的。一个永远说 OK 的自检
// 比没有自检更糟:它给人已经检查过的错觉。
//
// 所以这里钉住三件事:
//   1. 每条 canary 的 text 里**确实含**它声称的 secret —— 否则那个断言是空的
//   2. 至少有一条命名规则**真的命中了** —— 否则密钥消失只是被熵网顺手捡走的
//   3. 退到 hasBad 之前,✓/⚠/✗ 的语义没被搞反

import { describe, expect, test } from 'bun:test'
import { CANARIES, hasBad, scanKbLeaks, type Section } from '../src/commands/doctor.ts'
import { redactText } from '../src/core/redact.ts'

describe('脱敏 canary 表', () => {
  test('每条 canary 的 text 里真的含有它声称的 secret', () => {
    // 少了这条,一个把 secret 写成别的串的 canary 会永远「通过」
    for (const c of CANARIES) {
      expect(`${c.what}: ${c.text}`).toContain(c.secret)
    }
  })

  test('每条 canary 的密钥原文都被遮罩掉了', () => {
    for (const c of CANARIES) {
      const r = redactText(c.text)
      expect(`${c.what} → ${r.text}`).not.toContain(c.secret)
    }
  })

  test('每条 canary 都有一条命名规则真的命中(不是靠熵网顺手捡的)', () => {
    // 命名规则命中 = 「我们知道这是什么」。只靠 high_entropy 捡走的话,
    // 遮罩结果是 SUSPECT 而不是 REDACTED,人也读不出原本是什么变量。
    for (const c of CANARIES) {
      const r = redactText(c.text)
      expect(r.hits.length, `${c.what} 没有任何命名规则命中`).toBeGreaterThan(0)
    }
  })

  test('canary 没有踩到白名单 —— 否则 doctor 会把它误报成「脱敏失效」', () => {
    // 白名单放行假密钥是对的(fixture 天天用),但 canary 必须避开那些词,
    // 否则 redactText 放行它、doctor 判定泄露,两边都没错却互相矛盾。
    for (const c of CANARIES) {
      const r = redactText(c.text)
      expect(r.hits.length, `${c.what} 被白名单放行了`).toBeGreaterThan(0)
    }
  })

  test('表是满的 —— 每条已知的密钥类型都有 canary', () => {
    const whats = CANARIES.map(c => c.what).join(' ')
    for (const kind of ['私钥', 'sk-', 'GitHub', 'AWS', 'Slack', 'JWT', 'Bearer', 'X-Api-Key', '连接串', '赋值']) {
      expect(whats).toContain(kind)
    }
  })
})

describe('退出码语义', () => {
  const sec = (level: 'ok' | 'warn' | 'bad'): Section[] => [{ title: 't', items: [{ level, text: 'x' }] }]

  test('只有 ✗ 算失败', () => {
    expect(hasBad(sec('ok'))).toBe(false)
    expect(hasBad(sec('bad'))).toBe(true)
  })

  test('⚠ 不该让脚本判失败 —— 一个总退 1 的 doctor 等于没有', () => {
    expect(hasBad(sec('warn'))).toBe(false)
  })

  test('✗ 藏在任何一段里都要被抓到', () => {
    const sections: Section[] = [
      { title: 'a', items: [{ level: 'ok', text: 'x' }] },
      { title: 'b', items: [{ level: 'warn', text: 'y' }, { level: 'bad', text: 'z' }] },
    ]
    expect(hasBad(sections)).toBe(true)
  })
})

describe('知识库落盘扫描', () => {
  // 拼接造串，避免测试文件本身被扫到
  const key = ['sk-', 'Qw8zR2mK9pL4xV7nB1dF6hJ3tY5cA0s'].join('')

  test('已遮罩的标记不算泄露 —— 这正是前缀 grep 会误报的地方', () => {
    const text = '## 证据\n- key: «REDACTED:api_key»\n- ANTHROPIC_AUTH_TOKEN=«REDACTED»\n'
    expect(scanKbLeaks([{ path: 'a.md', text }])).toEqual([])
  })

  test('真实形状的密钥被抓到，只报规则名不回显原文', () => {
    const leaks = scanKbLeaks([{ path: 'b.md', text: `证据: ${key}` }])
    expect(leaks).toHaveLength(1)
    expect(leaks[0]!.rules).toContain('api_key_sk')
    expect(JSON.stringify(leaks)).not.toContain(key)
  })
})
