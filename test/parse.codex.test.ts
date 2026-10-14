import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { codexHumanText, parseCodexSession, patchFiles, readOutput } from '../src/adapters/codex/parse.ts'
import { findCodexSessions } from '../src/adapters/codex/sessions.ts'
import { detect } from '../src/core/signals.ts'

const DIR = join(import.meta.dir, 'fixtures', 'codex-sessions')
const FIXTURE = join(DIR, 'rollout-2026-10-01T08-00-00-019e0000-aaaa-7bbb-8ccc-0123456789ab.jsonl')

const parse = () => parseCodexSession(FIXTURE, { redact: false })

describe('parseCodexSession', () => {
  test('头部:session_meta 里的 id / cwd / 分支', async () => {
    const s = await parse()
    expect(s.host).toBe('codex')
    expect(s.sessionId).toBe('019e0000-aaaa-7bbb-8ccc-0123456789ab')
    expect(s.cwd).toBe('/tmp/repo')
    expect(s.gitBranch).toBe('main')
  })

  test('只有真人输入是 human —— AGENTS.md / environment_context 注入被剥掉,event_msg 不重复计', async () => {
    const s = await parse()
    expect(s.turns.filter(t => t.role === 'human').map(t => t.text)).toEqual([
      '把 util 模块迁到路径别名下,并修好迁移后的构建报错',
      '不对,我说的是 tsconfig 的 paths 没生效',
    ])
  })

  test('工具名归一化:exec_command/shell → Bash,apply_patch 按文件拆成 Edit', async () => {
    const s = await parse()
    const calls = s.turns.flatMap(t => t.toolCalls)
    expect(calls.map(c => c.name)).toEqual(['Bash', 'Edit', 'Edit', 'Edit', 'Bash'])
    expect(calls.filter(c => c.name === 'Edit').map(c => c.input['file_path'])).toEqual(['src/a.ts', 'tsconfig.json', 'src/a.ts'])
    for (const c of calls) expect(c.result).not.toBeNull()
  })

  test('成败看退出码 / patch 报错,失败的签名可以跨两种输出格式对上', async () => {
    const s = await parse()
    const calls = s.turns.flatMap(t => t.toolCalls)
    expect(calls.map(c => c.result?.ok)).toEqual([false, true, true, false, false])
    const bash = calls.filter(c => c.name === 'Bash')
    expect(bash[0]?.result?.errorSig).toBeDefined()
    expect(bash[0]?.result?.errorSig).toBe(bash[1]?.result?.errorSig)
    expect(bash[0]?.result?.evidence[0]).toEqual({ kind: 'command', text: 'npm run build' })
  })

  test('compacted 记成警告,未知类型计数不报错', async () => {
    const s = await parse()
    expect(s.warnings.some(w => w.includes('压缩'))).toBe(true)
    expect(s.unknownTypes['?brand_new_type']).toBe(1)
    expect(s.unknownTypes['reasoning']).toBe(1)
  })

  test('能喂给同一套信号规则(同一错误复现)', async () => {
    const { signals } = detect(await parse())
    expect(signals.map(x => x.kind)).toContain('repeat_error')
  })
})

describe('小件', () => {
  test('codexHumanText 按块判定:带图的提问不会被整条丢掉', () => {
    expect(codexHumanText(['<image name=[Image #1] path="/x.png">', '</image>', '看这个报错'])).toBe('看这个报错')
    expect(codexHumanText('<environment_context>…</environment_context>')).toBe('')
  })

  test('patchFiles 收齐 Add/Update/Delete,去重', () => {
    expect(patchFiles('*** Add File: a\n*** Update File: b\n*** Delete File: a\n')).toEqual(['a', 'b'])
  })

  test('readOutput 认两种格式', () => {
    expect(readOutput('Process exited with code 3\nOutput:\nboom')).toEqual({ exitCode: 3, body: 'boom' })
    expect(readOutput('{"output":"ok","metadata":{"exit_code":0}}')).toEqual({ exitCode: 0, body: 'ok' })
    expect(readOutput('plain').exitCode).toBeNull()
  })

  test('findCodexSessions 递归找 rollout-*.jsonl,id 取文件名里的 uuid', () => {
    const found = findCodexSessions(join(import.meta.dir, 'fixtures'))
    expect(found.map(f => f.sessionId)).toEqual(['019e0000-aaaa-7bbb-8ccc-0123456789ab'])
  })
})
