// hook 那条热路径的测试。
//
// 分两层:
//   · 纯函数层(tailFacts / allowedNow / firedRecently / remember)—— 直接 import
//     `nudge.ts`。**不能 import `entry.ts`**:那个文件一被 import 就会跑 hook,
//     而它会 readFileSync(0),在测试进程里永久阻塞(实测把 bun test 挂死过)。
//   · 进程层 —— 真的把 hook 当进程跑一遍,验 stdin→stdout 与退出码。
//     跑的是 `src/hook/entry.ts` 而不是 `dist/hook.mjs`,好让 `bun test`
//     不依赖先构建;打包产物本身在验收命令里单独跑(见 docs/design.md)。
//
// ★ 每个进程用例都必须把 COACH_KB 指到临时目录。hook 会**写 state.json**,
//   漏了这一步就是往用户真的 ~/knowledge 里写测试数据。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseClaudeSession } from '../src/adapters/claude-code/parse.ts'
import { DEFAULT_CONFIG, type CoachConfig } from '../src/core/config.ts'
import type { Session } from '../src/core/model.ts'
import { kbPaths } from '../src/core/paths.ts'
import { defaultState, type CoachStateFile } from '../src/core/state.ts'
import { allowedNow, firedRecently, remember, tailFacts } from '../src/hook/nudge.ts'

const REPO = join(import.meta.dir, '..')
/** 有一处重复报错 + 一次 Edit。用来验「同一报错复现」那条通道。 */
const FIXTURE = join(REPO, 'test/fixtures/claude-sessions/nudge.jsonl')
/**
 * 没有报错,只有一次 Edit。
 *
 * 单独造一个夹具是必须的:`nudgeFor` **先**看报错计数、**再**看用户纠正,
 * 所以只要夹具里有重复报错,纠正那条通道就永远走不到 —— 拿 nudge.jsonl
 * 去测纠正,测到的其实是报错通道(实测踩过)。
 */
const QUIET = join(REPO, 'test/fixtures/claude-sessions/correction.jsonl')
/** 夹具里两条报错原文不同(文件路径不同),但归一化后是同一个签名 —— 见下。 */
const SIG = 'Error: Cannot find module <path> from <path>'

let KB = ''
beforeEach(() => {
  KB = mkdtempSync(join(tmpdir(), 'coach-hook-'))
})
afterEach(() => {
  rmSync(KB, { recursive: true, force: true })
})

const cfg = (over: Partial<CoachConfig['hook']> = {}): CoachConfig => ({
  hook: { ...DEFAULT_CONFIG.hook, ...over },
})

// ---------------------------------------------------------------------------
// tailFacts
// ---------------------------------------------------------------------------

describe('tailFacts', () => {
  test('两次不同路径的同一个报错，归一成一个签名、计 2 次', async () => {
    const session: Session = await parseClaudeSession(FIXTURE)
    const f = tailFacts(session)
    // 夹具里两条 stderr 是**不同的字符串**(test/auth.test.ts vs test/login.test.ts)。
    // 如果这里数出 2 个签名,说明 errorSignature 没在归一化,「同一错误复现」
    // 这条信号就永远不会触发 —— 而它正是最值钱的那条。
    expect([...f.errorCounts.keys()]).toEqual([SIG])
    expect(f.errorCounts.get(SIG)).toBe(2)
  })

  test('动过文件就看得到', async () => {
    const session: Session = await parseClaudeSession(FIXTURE)
    expect(tailFacts(session).touchedFiles).toBe(true)
  })

  test('空会话不炸', () => {
    const empty = { turns: [] } as unknown as Session
    const f = tailFacts(empty)
    expect(f.errorCounts.size).toBe(0)
    expect(f.touchedFiles).toBe(false)
  })

  test('成功的调用不算进报错', () => {
    const session = {
      turns: [
        {
          toolCalls: [
            { name: 'Bash', result: { ok: true, evidence: [] } },
            { name: 'Edit', result: { ok: true, evidence: [] } },
          ],
        },
      ],
    } as unknown as Session
    const f = tailFacts(session)
    expect(f.errorCounts.size).toBe(0)
    expect(f.touchedFiles).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 冷却与上限 —— 提醒的价值在于稀,不在于多
// ---------------------------------------------------------------------------

describe('allowedNow', () => {
  const T = Date.parse('2026-10-14T10:00:00.000Z')

  test('全新的 state 放行', () => {
    expect(allowedNow(defaultState(), cfg(), T)).toBe(true)
  })

  test('刚说过话就不再说（最小间隔）', () => {
    const s = defaultState()
    s.hook.lastFiredAt = new Date(T - 30_000).toISOString()
    s.hook.firedDate = '2026-10-14'
    s.hook.firedToday = 1
    expect(allowedNow(s, cfg({ minGapSeconds: 600 }), T)).toBe(false)
    expect(allowedNow(s, cfg({ minGapSeconds: 10 }), T)).toBe(true)
  })

  test('到上限就闭嘴', () => {
    const s = defaultState()
    s.hook.firedDate = '2026-10-14'
    s.hook.firedToday = 6
    expect(allowedNow(s, cfg({ maxPerDay: 6 }), T)).toBe(false)
  })

  // 不重置的话昨天用满 6 次,今天一次都不提醒 —— 一个只在第一天工作的功能。
  test('跨天必须重置计数', () => {
    const s = defaultState()
    s.hook.firedDate = '2026-10-13'
    s.hook.firedToday = 99
    s.hook.lastFiredAt = new Date(T - 1000).toISOString()
    expect(allowedNow(s, cfg({ maxPerDay: 6, minGapSeconds: 600 }), T)).toBe(true)
  })

  test('lastFiredAt 被手改成垃圾时放行而不是永久静音', () => {
    const s = defaultState()
    s.hook.lastFiredAt = '不是时间'
    s.hook.firedDate = '2026-10-14'
    s.hook.firedToday = 1
    expect(allowedNow(s, cfg(), T)).toBe(true)
  })
})

describe('firedRecently / remember', () => {
  const T = Date.parse('2026-10-14T10:00:00.000Z')

  test('冷却窗口内的 key 被认出来', () => {
    const s = defaultState()
    s.hook.firedKeys = { 最近的: Math.floor(T / 1000) - 60, 很旧的: Math.floor(T / 1000) - 999_999 }
    const set = firedRecently(s, cfg({ cooldownSeconds: 24 * 3600 }), T)
    expect(set.has('最近的')).toBe(true)
    expect(set.has('很旧的')).toBe(false)
  })

  test('记一笔会更新计数、时间与 key', () => {
    const s = defaultState()
    remember(s, SIG, T, cfg())
    expect(s.hook.firedToday).toBe(1)
    expect(s.hook.firedDate).toBe('2026-10-14')
    expect(s.hook.lastFiredAt).toBe(new Date(T).toISOString())
    expect(s.hook.firedKeys[SIG]).toBe(Math.floor(T / 1000))
  })

  test('同一天记第二笔是 2，不是 1', () => {
    const s = defaultState()
    remember(s, 'a', T, cfg())
    remember(s, 'b', T, cfg())
    expect(s.hook.firedToday).toBe(2)
  })

  test('第二天记一笔从 1 重新开始', () => {
    const s = defaultState()
    remember(s, 'a', T, cfg())
    remember(s, 'b', T + 86_400_000, cfg())
    expect(s.hook.firedToday).toBe(1)
  })

  // 不清理的话这个表只增不减,而 state.json 每次都被整个读写 ——
  // 它会慢慢变成热路径上最贵的那一项。
  test('过期很久的 key 会被清掉', () => {
    const s = defaultState()
    s.hook.firedKeys = { 上古: Math.floor(T / 1000) - 999_999 }
    remember(s, SIG, T, cfg({ cooldownSeconds: 3600 }))
    expect(s.hook.firedKeys['上古']).toBeUndefined()
    expect(s.hook.firedKeys[SIG]).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 进程层：stdin → stdout、退出码、各种"该闭嘴"的情形
// ---------------------------------------------------------------------------

interface Run {
  stdout: string
  stderr: string
  code: number
}

async function runHookProc(stdin: unknown, env: Record<string, string> = {}): Promise<Run> {
  const proc = Bun.spawn([process.execPath, join(REPO, 'src/hook/entry.ts')], {
    cwd: REPO,
    stdin: new Blob([typeof stdin === 'string' ? stdin : JSON.stringify(stdin)]),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, COACH_KB: KB, ...env },
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  return { stdout, stderr, code }
}

const payload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  session_id: 'abc-123',
  transcript_path: FIXTURE,
  cwd: '/tmp/demo',
  prompt: '帮我把鉴权那个测试跑起来',
  hook_event_name: 'UserPromptSubmit',
  ...over,
})

describe('进程层', () => {
  test('同一个报错出现了 2 次 → 说一句话，退出码 0', async () => {
    const r = await runHookProc(payload())
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('[coach-kb]')
    expect(r.stdout.trim().split('\n')).toHaveLength(1)
  })

  // 输出必须是**纯文本**。UserPromptSubmit 上只有"整个 stdout 恰好是一个
  // JSON 对象"才会被解析,而半截 JSON 既不算上下文也不算报错 —— 提醒会凭空消失。
  test('stdout 就是一行纯文本，不是 JSON 信封', async () => {
    const r = await runHookProc(payload())
    expect(r.stdout.trim().startsWith('{')).toBe(false)
    expect(() => JSON.parse(r.stdout)).toThrow()
  })

  test('说第二次之前先闭嘴（同一会话里同一个坑不反复念）', async () => {
    const first = await runHookProc(payload())
    expect(first.stdout).toContain('[coach-kb]')
    const second = await runHookProc(payload())
    expect(second.stdout).toBe('')
    expect(second.code).toBe(0)
  })

  test('记账真的落到了 state.json 里', async () => {
    await runHookProc(payload())
    const state = JSON.parse(readFileSync(kbPaths(KB).state, 'utf8')) as CoachStateFile
    expect(state.hook.firedToday).toBe(1)
    expect(Object.keys(state.hook.firedKeys)).toEqual([SIG])
  })

  // 递归防护：我们自己的 headless 调用不该再触发我们。
  test('哨兵在场时一声不吭', async () => {
    const r = await runHookProc(payload(), { COACH_BRAIN_CALL: '1' })
    expect(r.stdout).toBe('')
    expect(r.code).toBe(0)
  })

  test('挂在别的事件上时不说话（Stop 上我们的输出语义不同）', async () => {
    const r = await runHookProc(payload({ hook_event_name: 'Stop' }))
    expect(r.stdout).toBe('')
  })

  test('config 里关掉就彻底闭嘴', async () => {
    mkdirSync(kbPaths(KB).meta, { recursive: true })
    writeFileSync(kbPaths(KB).config, JSON.stringify({ hook: { enabled: false } }))
    const r = await runHookProc(payload())
    expect(r.stdout).toBe('')
  })

  // 用户纠正 + 动过文件 —— 另一条通道,不依赖报错计数。
  test('用户纠正了 AI 且动过文件 → 提醒', async () => {
    const r = await runHookProc(payload({ transcript_path: QUIET, prompt: '不对,我说的是先读文件再改' }))
    expect(r.stdout).toContain('[coach-kb]')
    expect(r.stdout).toContain('纠正')
  })

  test('提到记过的知识点 → 让他先凭记忆复述', async () => {
    mkdirSync(kbPaths(KB).meta, { recursive: true })
    writeFileSync(
      kbPaths(KB).recall,
      JSON.stringify([{ id: 'pitfall-x', title: 'bun 路径别名', terms: ['bun', 'tsconfig'] }]),
    )
    const r = await runHookProc(payload({ transcript_path: QUIET, prompt: 'bun 读不到 tsconfig 里的别名' }))
    expect(r.stdout).toContain('pitfall-x')
    expect(r.stdout).toContain('凭记忆')
  })

  test('config 里关掉 recall 就不提旧卡', async () => {
    mkdirSync(kbPaths(KB).meta, { recursive: true })
    writeFileSync(kbPaths(KB).recall, JSON.stringify([{ id: 'pitfall-x', title: 't', terms: ['bun', 'tsconfig'] }]))
    writeFileSync(kbPaths(KB).config, JSON.stringify({ hook: { recall: false } }))
    const r = await runHookProc(payload({ transcript_path: QUIET, prompt: 'bun 读不到 tsconfig' }))
    expect(r.stdout).toBe('')
  })

  test('只是纠正、但没动过文件 → 不说话', async () => {
    // secrets.jsonl 里没有 Edit/Write,所以 touchedFiles=false。
    const r = await runHookProc(
      payload({ transcript_path: join(REPO, 'test/fixtures/claude-sessions/secrets.jsonl'), prompt: '不对,我说的是别的' }),
    )
    expect(r.stdout).toBe('')
  })

  describe('无论输入多烂都必须安静地 exit 0', () => {
    // ★ 这一组是硬约束,不是防御性编程的洁癖:exit 2 在 UserPromptSubmit 上
    //   会**把用户的 prompt 拦下来不发给模型**。hook 崩一次 = 用户那句话白打。
    //
    //   这里一律用 QUIET 那个没有报错的夹具,这样"stdout 为空"是真的在断言
    //   "闭嘴",而不是被夹具里那条重复报错碰巧救过去。
    const cases: Array<[string, unknown]> = [
      ['空 stdin', ''],
      ['不是 JSON', '这不是 json'],
      ['JSON 但是数组', '[]'],
      ['JSON 是 null', 'null'],
      ['没有 transcript_path', { hook_event_name: 'UserPromptSubmit' }],
      ['transcript_path 指向不存在的文件', payload({ transcript_path: '/tmp/根本没有这个文件.jsonl' })],
      ['transcript_path 是空串', payload({ transcript_path: '' })],
      ['prompt 字段是数字', payload({ transcript_path: QUIET, prompt: 12345 })],
      ['prompt 字段是 null', payload({ transcript_path: QUIET, prompt: null })],
      ['没有 prompt 字段', { transcript_path: QUIET, hook_event_name: 'UserPromptSubmit' }],
    ]
    for (const [name, input] of cases) {
      test(name, async () => {
        const r = await runHookProc(input, {})
        expect(r.code).toBe(0)
        expect(r.stdout).toBe('')
      })
    }

    // 畸形输入遇上"本来该说话"的会话,唯一的要求是**别崩、别拦 prompt** ——
    // 说不说都行,但绝不能因为字段畸形就变成非零退出码。
    test('畸形字段 + 该提醒的会话：要么说一行，要么不说，但永远 exit 0', async () => {
      for (const input of [payload({ prompt: 12345 }), payload({ prompt: null }), payload({ cwd: 42 })]) {
        const r = await runHookProc(input)
        expect(r.code).toBe(0)
        expect(r.stdout.trim().split('\n').filter(l => l !== '').length).toBeLessThanOrEqual(1)
      }
    })
  })
})
