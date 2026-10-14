import { describe, expect, test } from 'bun:test'
import { beginMark, endMark, isOurs, ownedTags, pickSlot, renderOwn, stamp, unstamp } from '../src/core/mark.ts'
import type { Target } from '../src/core/mark.ts'

// 旧 install.mjs 的原文（第 37–38 行），逐字抄来。这两行是**契约**：
// 认不出它们，新工具就会在已有旧段落的文件里追加出第二个 coach:begin。
const LEGACY_BEGIN = '<!-- coach:begin —— 由 coach 维护,勿手改;卸载:--uninstall -->'
const LEGACY_END = '<!-- coach:end -->'

describe('与旧版的字节兼容', () => {
  test('默认 tag 产出旧版原文', () => {
    expect(beginMark()).toBe(LEGACY_BEGIN)
    expect(endMark()).toBe(LEGACY_END)
    expect(beginMark('coach')).toBe(LEGACY_BEGIN)
  })

  test('能认出旧版写下的段落', () => {
    const legacyFile = `# 项目说明\n\n${LEGACY_BEGIN}\n\n老的协议正文\n\n${LEGACY_END}\n`
    expect(isOurs(legacyFile)).toBe(true)
    expect(stamp(legacyFile, '新正文').text).not.toContain('老的协议正文')
    expect(unstamp(legacyFile).text).toBe('# 项目说明\n')
  })
})

describe('stamp', () => {
  test('空文件不产生前导空行', () => {
    expect(stamp('', '正文').text).toBe(`${LEGACY_BEGIN}\n\n正文\n\n${LEGACY_END}\n`)
    expect(stamp('\n\n', '正文').text).toBe(`${LEGACY_BEGIN}\n\n正文\n\n${LEGACY_END}\n`)
  })

  test('重复执行幂等 —— 旧脚本的自检就是这一条', () => {
    let text = '# 标题\n'
    for (let i = 0; i < 5; i += 1) text = stamp(text, '正文').text
    expect(text.match(/coach:begin/g)).toHaveLength(1)
    expect(text).not.toMatch(/\n{3,}/)
    expect(text).toBe(`# 标题\n\n${LEGACY_BEGIN}\n\n正文\n\n${LEGACY_END}\n`)
  })

  // 旧脚本 glue 的三种分支，少一个就会一行一行地长空白
  test('文件结尾三种换行情况都不长空白', () => {
    for (const tail of ['', '\n', '\n\n']) {
      const once = stamp(`正文${tail}`, '块').text
      const twice = stamp(once, '块').text
      expect(twice).toBe(once)
      expect(once).not.toMatch(/\n{3,}/)
    }
  })

  test('已有段落就地替换，位置不挪', () => {
    const text = `前面\n\n${LEGACY_BEGIN}\n\n旧的\n\n${LEGACY_END}\n\n后面\n`
    const next = stamp(text, '新的').text
    expect(next).toBe(`前面\n\n${LEGACY_BEGIN}\n\n新的\n\n${LEGACY_END}\n\n后面\n`)
    expect(next).toContain('后面')
  })

  test('内容没变时报 changed=false', () => {
    const once = stamp('# 标题\n', '正文').text
    expect(stamp(once, '正文').changed).toBe(false)
    expect(stamp(once, '别的内容').changed).toBe(true)
  })

  test('正文首尾空白被吃掉', () => {
    expect(stamp('', '\n\n  正文  \n\n').text).toContain('\n\n正文\n\n')
  })

  test('自定义 tag 与 coach 段落并存，互不干扰', () => {
    let text = stamp('# 标题\n', '协议正文').text
    text = stamp(text, '规则正文', 'coach-kb').text
    expect(text).toContain('协议正文')
    expect(text).toContain('规则正文')
    expect(ownedTags(text).sort()).toEqual(['coach', 'coach-kb'])
  })

  test('末尾有未闭合的 BEGIN 时，退化成追加（宁可重复也不丢内容）', () => {
    const broken = `前面\n\n${LEGACY_BEGIN}\n\n没有结束标记\n`
    const next = stamp(broken, '新的').text
    expect(next).toContain('没有结束标记')
    expect(next).toContain('新的')
  })
})

describe('unstamp', () => {
  test('撤回后回到原样，不留空行', () => {
    const before = '# 标题\n\n正文\n'
    const stamped = stamp(before, '块').text
    const after = unstamp(stamped).text
    expect(after).toBe(before)
    expect(after).not.toMatch(/\n{3,}/)
  })

  test('本来干净的文件撤回后应该字节还原', () => {
    const before = '内容\n'
    expect(unstamp(stamp(before, '块').text).text).toBe(before)
  })

  test('没有我们的段落时是恒等变换', () => {
    const r = unstamp('# 别人的文件\n')
    expect(r.changed).toBe(false)
    expect(r.text).toBe('# 别人的文件\n')
  })

  // 卸载必须"干净"到 git 看不出来 —— 这是 rule uninstall 的验收标准。
  // 成立范围：**以恰好一个换行结尾的文件**，也就是 POSIX 意义上正常的文本文件
  // （`git` 自己也把「末尾没有换行」记成一个 \ No newline at end of file）。
  test('装配→撤回 是恒等变换', () => {
    const CASES = ['', '内容\n', '# 标题\n\n正文\n', '# 标题\n\n- 一\n- 二\n', '前\n\n\n后\n']
    for (const before of CASES) {
      const stamped = stamp(before, '块内容').text
      expect(isOurs(stamped)).toBe(true)
      expect(unstamp(stamped).text).toBe(before)
    }
  })

  // 尾部空白不规范的文件会被规范掉。这不是 bug，写出来免得日后被反复"修"：
  // stamp 的接缝胶水有歧义 —— `'内容'`、`'内容\n'`、`'内容\n\n'` 三种输入
  // 装配出来是**同一串**，所以撤回只能还原成同一串，选的是更常见的那一种。
  // 要真正无损，得把原始尾空白编进标记串里，不划算。
  test('尾部空白不规范的输入会被规范掉（有意的取舍）', () => {
    const norm = (before: string): string => unstamp(stamp(before, '块内容').text).text
    expect(norm('内容')).toBe('内容\n') // 补上一个换行
    expect(norm('内容\n\n')).toBe('内容\n') // 收掉多余空行
    expect(norm('\n')).toBe('') // 纯空白 → 空文件
    expect(norm('\n\n')).toBe('')
    expect(norm('   \n')).toBe('')
    expect(norm('中间\n\n\n有内容\n')).toBe('中间\n\n\n有内容\n') // 文件中间的空行不受影响
  })

  test('只撤自己那个 tag', () => {
    let text = stamp('根\n', '协议').text
    text = stamp(text, '规则', 'coach-kb').text
    const without = unstamp(text, 'coach-kb').text
    expect(without).toContain('协议')
    expect(without).not.toContain('规则')
  })
})

describe('renderOwn / isOurs', () => {
  test('独占文件的正文带着凭证行', () => {
    const md = renderOwn('规则正文')
    expect(md).toBe(`${LEGACY_BEGIN}\n\n规则正文\n`)
    expect(isOurs(md)).toBe(true)
  })

  test('不是我们的文件', () => {
    expect(isOurs('# 随便什么\n')).toBe(false)
  })
})

describe('ownedTags', () => {
  test('一个都没有', () => {
    expect(ownedTags('# 干净文件\n')).toEqual([])
  })

  // doctor 靠这个抓「重复注入」
  test('重复注入同一 tag 时报告两次', () => {
    const broken = `${beginMark()}\n\nA\n\n${endMark()}\n\n${beginMark()}\n\nB\n\n${endMark()}\n`
    expect(ownedTags(broken)).toEqual(['coach', 'coach'])
  })
})

describe('pickSlot', () => {
  const exists = (...have: string[]) => (p: string) => have.includes(p)
  const target: Target = { name: 'x', flag: '--x', mode: 'stamp', slots: ['A.md', 'B.md'] }

  test('--slot 指明的直接算数', () => {
    expect(pickSlot({ ...target, slot: 'Z.md' }, exists('A.md'))).toBe('Z.md')
  })

  test('requires 不在就不写', () => {
    expect(pickSlot({ ...target, requires: 'package.json' }, exists('A.md'))).toBeNull()
    expect(pickSlot({ ...target, requires: 'package.json' }, exists('package.json'))).toBe('A.md')
  })

  test('取第一个已存在的', () => {
    expect(pickSlot(target, exists('B.md'))).toBe('B.md')
  })

  test('都不存在时取第一个（由调用方决定要不要建）', () => {
    expect(pickSlot(target, exists())).toBe('A.md')
  })

  test('没有候选槽位时返回 null', () => {
    expect(pickSlot({ ...target, slots: [] }, exists())).toBeNull()
  })
})
