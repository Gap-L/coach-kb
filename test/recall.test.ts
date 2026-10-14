import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { kbPaths } from '../src/core/paths.ts'
import { loadRecall, matchRecall, recallEntry, writeRecall } from '../src/core/recall.ts'
import { nudgeFor } from '../src/core/signals.ts'

const card = {
  id: 'pitfall-bun-module',
  title: 'bun 找不到模块是 tsconfig paths 没生效',
  tags: ['bun', 'tsconfig'],
  evidence: ['tsconfig.json:5', 'src/hook/entry.ts:12'],
  mine: '路径别名只在 tsc 里生效，bun 要单独配',
}

let KB = ''
beforeEach(() => {
  KB = mkdtempSync(join(tmpdir(), 'coach-recall-'))
})
afterEach(() => {
  rmSync(KB, { recursive: true, force: true })
})

describe('recallEntry', () => {
  test('收 tags、证据文件名（带/不带后缀）、标题长词', () => {
    const e = recallEntry(card)
    expect(e.terms).toContain('bun')
    expect(e.terms).toContain('tsconfig')
    expect(e.terms).toContain('tsconfig.json')
    expect(e.terms).toContain('entry.ts')
    expect(e.terms).toContain('paths')
  })

  test('太短的词和停用词不收', () => {
    const e = recallEntry({ ...card, tags: ['ts', 'test'] })
    expect(e.terms).not.toContain('ts')
    expect(e.terms).not.toContain('test')
  })
})

describe('matchRecall', () => {
  const entries = [recallEntry(card)]

  test('命中两个词才说话', () => {
    expect(matchRecall('bun 又报找不到模块了，tsconfig 是不是有问题', entries, new Set())).not.toBeNull()
  })

  test('只撞上一个词闭嘴', () => {
    expect(matchRecall('帮我装一下 bun', entries, new Set())).toBeNull()
  })

  test('冷却里的卡不再提', () => {
    expect(matchRecall('bun tsconfig', entries, new Set(['recall:pitfall-bun-module']))).toBeNull()
  })

  test('坏数据不炸', () => {
    expect(matchRecall('bun tsconfig', [{ id: 'x', title: 'y', terms: null as never }], new Set())).toBeNull()
  })
})

describe('writeRecall / loadRecall', () => {
  test('没写自己那句话的卡不进检索表 —— 拿 AI 摘要来复习没有意义', () => {
    writeRecall(KB, [card, { ...card, id: 'inbox-one', mine: '' }])
    const got = loadRecall(KB).map(e => e.id)
    expect(got).toEqual(['pitfall-bun-module'])
  })

  test('文件不存在时返回空表', () => {
    expect(existsSync(kbPaths(KB).recall)).toBe(false)
    expect(loadRecall(KB)).toEqual([])
  })
})

describe('nudgeFor 的新通道', () => {
  const base = { errorCounts: new Map<string, number>(), touchedFiles: false, alreadyNudged: new Set<string>() }

  test('命中旧卡 → 让他先凭记忆说，不贴卡', () => {
    const hit = matchRecall('bun tsconfig 又坏了', [recallEntry(card)], new Set())
    const n = nudgeFor({ ...base, prompt: 'bun tsconfig 又坏了', recall: hit })
    expect(n?.key).toBe('recall:pitfall-bun-module')
    expect(n?.text).toContain('凭记忆')
    expect(n?.text).not.toContain(card.mine)
  })

  test('说没懂 → 引到 coach skill', () => {
    const n = nudgeFor({ ...base, prompt: '这段我还是没懂' })
    expect(n?.text).toContain('/coach-kb:coach')
  })

  test('报错复现仍然最先', () => {
    const n = nudgeFor({ ...base, errorCounts: new Map([['E', 2]]), prompt: '没懂' })
    expect(n?.key).toBe('E')
  })

  test('普通的话闭嘴', () => {
    expect(nudgeFor({ ...base, prompt: '帮我加个按钮' })).toBeNull()
  })
})
