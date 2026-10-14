import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { errorSignature, parseClaudeSession, projectSlug } from '../src/adapters/claude-code/parse.ts'

const FIXTURE = join(import.meta.dir, 'fixtures', 'claude-sessions', 'minimal.jsonl')

async function parse() {
  return parseClaudeSession(FIXTURE, { redact: false })
}

describe('parseClaudeSession', () => {
  test('只把真人输入当 human turn,tool_result 不算', async () => {
    const s = await parse()
    const humans = s.turns.filter(t => t.role === 'human')
    // fixture 里有 3 句真人输入，另有 5 行 tool_result 的 user 行
    expect(humans.map(t => t.text)).toEqual([
      '帮我把鉴权重构成中间件',
      '我打算先把 token 校验抽成一个函数,再让路由去调它',
      '不对,我说的是路径别名的问题,不是 jwt 库的问题',
    ])
  })

  test('tool_result 回填到对应的 tool_use 上', async () => {
    const s = await parse()
    const calls = s.turns.flatMap(t => t.toolCalls)
    expect(calls.map(c => c.name)).toEqual(['Read', 'Edit', 'Bash', 'Edit', 'Bash'])
    for (const c of calls) expect(c.result).not.toBeNull()
  })

  test('Edit 的证据是「文件:行号」——行号来自 structuredPatch', async () => {
    const s = await parse()
    const edit = s.turns.flatMap(t => t.toolCalls).find(c => c.name === 'Edit')
    expect(edit?.result?.evidence[0]).toEqual({ kind: 'file', text: 'src/auth.ts:88' })
  })

  test('Bash 的证据同时有命令原文和 stderr', async () => {
    const s = await parse()
    const bash = s.turns.flatMap(t => t.toolCalls).find(c => c.name === 'Bash')
    const kinds = bash?.result?.evidence.map(e => e.kind)
    expect(kinds).toEqual(['command', 'output'])
    expect(bash?.result?.evidence[0]?.text).toBe('bun test src/auth.test.ts')
  })

  test('失败的 Bash 判 ok=false 并给出签名', async () => {
    const s = await parse()
    const bash = s.turns.flatMap(t => t.toolCalls).filter(c => c.name === 'Bash')
    expect(bash.every(c => c.result?.ok === false)).toBe(true)
    expect(bash[0]?.result?.errorSig).toBe(
      'error TS#: Cannot find module <path> or its corresponding type declarations.',
    )
  })

  test('同一类报错、不同模块 ⇒ 同一个签名（复现信号靠它）', async () => {
    const a = errorSignature("error TS2307: Cannot find module '@/lib/jwt' or its corresponding type declarations.")
    const b = errorSignature("error TS2307: Cannot find module '@/lib/session' or its corresponding type declarations.")
    expect(a).toBe(b)
  })

  test('未知行类型被计数上报,而不是被当成对话', async () => {
    const s = await parse()
    expect(s.unknownTypes['future-unknown-type']).toBe(1)
    expect(s.unknownTypes['attachment']).toBe(2)
    expect(s.unknownTypes['ai-title']).toBe(1)
  })

  test('cwd / gitBranch / sessionId 从头部取到', async () => {
    const s = await parse()
    expect(s.sessionId).toBe('fixture-minimal')
    expect(s.cwd).toBe('/tmp/demo')
    expect(s.gitBranch).toBe('main')
  })

  test('水位线等于文件的真实行数', async () => {
    const s = await parse()
    const raw = await Bun.file(FIXTURE).text()
    expect(s.lines).toBe(raw.split('\n').filter(l => l !== '').length)
  })

  test('同一类报错归一化后不带具体模块名与行号', async () => {
    expect(errorSignature("error TS2307: Cannot find module 'lodash' at line 42")).toBe(
      'error TS#: Cannot find module <name> at line #',
    )
  })

  test('脱敏默认开着,能挡住密钥', async () => {
    const path = join(import.meta.dir, 'fixtures', 'claude-sessions', 'secrets.jsonl')
    const s = await parseClaudeSession(path)
    const all = JSON.stringify(s)
    expect(all).not.toContain('sk-ant-api03-')
    expect(all).not.toContain('ghp_')
    expect(all).toContain('«REDACTED')
  })
})

describe('projectSlug', () => {
  test('把 / 和 . 换成 -', () => {
    expect(projectSlug('/Users/lingaibo/workspace/coach-kb')).toBe('-Users-lingaibo-workspace-coach-kb')
    expect(projectSlug('/private/tmp/x.y')).toBe('-private-tmp-x-y')
  })
})
