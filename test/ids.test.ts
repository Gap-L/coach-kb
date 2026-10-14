import { describe, expect, test } from 'bun:test'
import { CARD_TYPES, cardId, fileNameFor, idFromFileName, isCardType, slugify } from '../src/core/ids.ts'

describe('cardId', () => {
  test('同一个输入永远得到同一个 id', () => {
    const a = cardId('pitfall', 'claude-code:sess-1', 7, 'repeat_error')
    const b = cardId('pitfall', 'claude-code:sess-1', 7, 'repeat_error')
    expect(a).toBe(b)
  })

  test('四个维度各自扰动都会换 id', () => {
    const base = cardId('pitfall', 's', 1, 'k')
    expect(cardId('concept', 's', 1, 'k')).not.toBe(base)
    expect(cardId('pitfall', 's2', 1, 'k')).not.toBe(base)
    expect(cardId('pitfall', 's', 2, 'k')).not.toBe(base)
    expect(cardId('pitfall', 's', 1, 'k2')).not.toBe(base)
  })

  test('形如 kb-<type>-<6位十六进制>', () => {
    for (const t of CARD_TYPES) {
      expect(cardId(t, 'a', 0, 'b')).toMatch(/^kb-[a-z]+-[0-9a-f]{6}$/)
    }
  })

  test('拼接边界不产生碰撞：("a#1","b") 与 ("a","1#b") 必须不同', () => {
    expect(cardId('pitfall', 'a#1', 2, 'b')).not.toBe(cardId('pitfall', 'a', 1, '2#b'))
  })
})

describe('slugify / fileNameFor / idFromFileName', () => {
  test('slug 去掉路径分隔符与标点', () => {
    expect(slugify('src/auth.ts 里的 token 过期')).toBe('src-auth-ts-里的-token-过期')
  })

  test('slug 有兜底，不会产出空文件名', () => {
    expect(slugify('!!!')).toBe('card')
    expect(slugify('')).toBe('card')
  })

  test('文件名往返拿回同一个 id', () => {
    const id = cardId('pattern', 'claude-code:abc', 3, 'user_correction')
    const file = fileNameFor(id, slugify('永远先读 fixture 再改断言'))
    expect(idFromFileName(file)).toBe(id)
  })

  test('不是我们的文件返回 null', () => {
    expect(idFromFileName('README.md')).toBeNull()
    expect(idFromFileName('kb-pitfall-zzzzzz-x.md')).toBeNull()
  })
})

describe('isCardType', () => {
  test('认四种，其余一律不认', () => {
    expect(CARD_TYPES.every(isCardType)).toBe(true)
    expect(isCardType('inbox')).toBe(false)
    expect(isCardType('')).toBe(false)
  })
})
