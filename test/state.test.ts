import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquire, withLock } from '../src/core/lock.ts'
import { kbPaths } from '../src/core/paths.ts'
import { defaultState, loadState, saveState, today } from '../src/core/state.ts'

let KB = ''
beforeEach(() => {
  KB = mkdtempSync(join(tmpdir(), 'coach-state-'))
})
afterEach(() => {
  rmSync(KB, { recursive: true, force: true })
})

describe('loadState', () => {
  test('文件不存在时给默认值，不抛', () => {
    expect(loadState(KB)).toEqual(defaultState())
  })

  test('JSON 烂掉时给默认值，不抛', () => {
    const p = kbPaths(KB)
    mkdirSync(p.meta, { recursive: true })
    writeFileSync(p.state, '{ 这不是 json')
    expect(loadState(KB)).toEqual(defaultState())
  })

  test('新旧版本混用时，缺的字段补默认值', () => {
    const p = kbPaths(KB)
    mkdirSync(p.meta, { recursive: true })
    // 模拟「旧版本写的、只有一半字段的 state」
    writeFileSync(p.state, JSON.stringify({ version: 1, sessions: { a: {} } }))
    const s = loadState(KB)
    expect(s.sessions['a']).toBeDefined()
    expect(s.brain.chosen).toBe('none')
    expect(s.hook.firedKeys).toEqual({})
    expect(s.digest.spentTodayUsd).toBe(0)
  })

  // 浅合并的经典陷阱：存盘的 hook 只少了 firedToday 一个字段，
  // 展开后整个 hook 被替换，于是 firedToday 变成 undefined，
  // 后面 `firedToday += 1` 会算出 NaN。
  test('嵌套对象按字段合并，不会被整体替换', () => {
    const p = kbPaths(KB)
    mkdirSync(p.meta, { recursive: true })
    writeFileSync(p.state, JSON.stringify({ hook: { firedDate: '2026-10-14', firedKeys: { k: 1 } } }))
    const s = loadState(KB)
    expect(s.hook.firedDate).toBe('2026-10-14')
    expect(s.hook.firedKeys).toEqual({ k: 1 })
    expect(s.hook.firedToday).toBe(0)
    expect(Number.isNaN(s.hook.firedToday + 1)).toBe(false)
  })
})

describe('saveState', () => {
  test('往返一致', () => {
    const s = defaultState()
    s.sessions['claude-code:x'] = {
      path: '/tmp/x.jsonl',
      size: 100,
      mtimeMs: 1,
      lines: 7,
      lastProcessedAt: '2026-10-14T00:00:00Z',
      cardsEmitted: ['kb-pitfall-abc123'],
    }
    saveState(KB, s)
    expect(loadState(KB)).toEqual(s)
  })

  test('落盘是原子的：不留临时文件', () => {
    saveState(KB, defaultState())
    const p = kbPaths(KB)
    expect(readFileSync(p.state, 'utf8')).toContain('"version"')
    // 临时文件必须已经 rename 掉了
    expect(readdirSync(p.meta).filter(f => f.includes('.tmp'))).toEqual([])
  })

  test('目录不存在时自己建', () => {
    const fresh = join(KB, 'deep', 'nested')
    saveState(fresh, defaultState())
    expect(loadState(fresh).version).toBe(1)
  })
})

describe('today', () => {
  test('本地时区的 YYYY-MM-DD', () => {
    expect(today(new Date(2026, 9, 14, 23, 30))).toBe('2026-10-14')
    expect(today(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01')
  })
})

describe('lock', () => {
  test('拿到锁之后，第二个人拿不到', () => {
    const a = acquire(KB, 'state', { waitMs: 0 })
    expect(a).not.toBeNull()
    expect(acquire(KB, 'state', { waitMs: 0 })).toBeNull()
    a?.release()
  })

  test('释放之后可以再拿', () => {
    acquire(KB, 'state', { waitMs: 0 })?.release()
    const b = acquire(KB, 'state', { waitMs: 0 })
    expect(b).not.toBeNull()
    b?.release()
  })

  test('重复 release 不炸（幂等）', () => {
    const a = acquire(KB, 'state', { waitMs: 0 })
    a?.release()
    expect(() => a?.release()).not.toThrow()
  })

  test('不同名字的锁互不影响', () => {
    const a = acquire(KB, 'state', { waitMs: 0 })
    const b = acquire(KB, 'digest', { waitMs: 0 })
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    a?.release()
    b?.release()
  })

  test('持有者已死时抢占陈旧锁', () => {
    const dir = join(KB, '.coach', 'lock', 'state')
    mkdirSync(dir, { recursive: true })
    // 一个几乎不可能存在的 pid
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: 999_999, startedAt: Date.now() }))
    const got = acquire(KB, 'state', { waitMs: 0 })
    expect(got).not.toBeNull()
    got?.release()
  })

  test('持有者还活着时绝不抢占', () => {
    const dir = join(KB, '.coach', 'lock', 'state')
    mkdirSync(dir, { recursive: true })
    // 本进程的 pid 一定是活的
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
    expect(acquire(KB, 'state', { waitMs: 0 })).toBeNull()
  })

  test('超过 staleMs 就抢占（哪怕 pid 看起来还活着）', () => {
    const dir = join(KB, '.coach', 'lock', 'state')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() - 60_000 }))
    const got = acquire(KB, 'state', { waitMs: 0, staleMs: 1000 })
    expect(got).not.toBeNull()
    got?.release()
  })
})

describe('withLock', () => {
  test('正常返回并释放', () => {
    expect(withLock(KB, 'state', { waitMs: 0 }, () => 42)).toBe(42)
    expect(acquire(KB, 'state', { waitMs: 0 })).not.toBeNull()
  })

  test('抛异常也释放 —— 否则一次崩溃就永久锁死知识库', () => {
    expect(() =>
      withLock(KB, 'state', { waitMs: 0 }, () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(acquire(KB, 'state', { waitMs: 0 })).not.toBeNull()
  })

  test('拿不到锁返回 null，不执行 fn', () => {
    acquire(KB, 'state', { waitMs: 0 })
    let ran = false
    const r = withLock(KB, 'state', { waitMs: 0 }, () => {
      ran = true
      return 1
    })
    expect(r).toBeNull()
    expect(ran).toBe(false)
  })
})
