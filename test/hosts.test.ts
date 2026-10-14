import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { MARKER, renderHostSkill } from '../src/core/hostskills.ts'
import { loadCards } from '../src/core/kb.ts'

const ROOT = join(import.meta.dir, '..')
const PLUGIN = join(ROOT, 'plugin')
const CLI = join(ROOT, 'src', 'cli.ts')

const SAMPLE = `---
name: review
description: 复盘
user-invocable: true
allowed-tools:
  - Bash(node \${CLAUDE_PLUGIN_ROOT}/dist/coach.mjs review)
---

# 复盘

\`\`\`
node \${CLAUDE_PLUGIN_ROOT}/dist/coach.mjs review --latest
\`\`\`

这一步见 \`save\` skill。review 这个词在正文里不该被改。
`

describe('renderHostSkill', () => {
  test('frontmatter 只留 name(加前缀)/description', () => {
    const md = renderHostSkill(SAMPLE, { host: 'codex', coach: '/opt/coach.mjs' })
    const fm = md.split('---')[1] as string
    expect(fm).toContain('name: coach-kb-review')
    expect(fm).toContain('description: 复盘')
    expect(fm).not.toContain('allowed-tools')
    expect(fm).not.toContain('user-invocable')
    expect(fm).not.toContain('Bash(')
  })

  test('Codex:换绝对路径,review 带 --host codex,正文散词不动', () => {
    const md = renderHostSkill(SAMPLE, { host: 'codex', coach: '/opt/coach.mjs' })
    expect(md).toContain('node /opt/coach.mjs review --host codex --latest')
    expect(md).not.toContain('CLAUDE_PLUGIN_ROOT')
    expect(md).toContain('`coach-kb-save` skill')
    expect(md).toContain('review 这个词在正文里不该被改')
  })

  test('WorkBuddy 不加 --host;带空格的路径被引起来', () => {
    const md = renderHostSkill(SAMPLE, { host: 'workbuddy', coach: '/my dir/coach.mjs' })
    expect(md).toContain('node "/my dir/coach.mjs" review --latest')
  })

  test('真实模板渲染后没有残留占位符', () => {
    for (const p of ['skills/review', 'skills/save', 'skills/kb', 'skills/due', 'hosts/workbuddy/report']) {
      const md = renderHostSkill(readFileSync(join(PLUGIN, p, 'SKILL.md'), 'utf8'), { host: 'workbuddy', coach: '/c.mjs' })
      expect(md).not.toMatch(/CLAUDE_PLUGIN_ROOT|\{\{COACH\}\}/)
    }
  })
})

describe('coach install --codex / --workbuddy(真跑,写进临时目录)', () => {
  let dir: string
  const run = (...argv: string[]) =>
    spawnSync('bun', [CLI, 'install', ...argv], {
      env: { ...process.env, COACH_PLUGIN_DIR: PLUGIN, COACH_CODEX_SKILLS: join(dir, 'codex'), COACH_WORKBUDDY_SKILLS: join(dir, 'wb'), COACH_CURSOR_SKILLS: join(dir, 'cursor') },
      encoding: 'utf8',
    })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'coach-hosts-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('默认只预演', () => {
    expect(run('--codex').status).toBe(0)
    expect(existsSync(join(dir, 'codex'))).toBe(false)
  })

  test('装 → 幂等 → 卸,别人的 skill 不碰', () => {
    mkdirSync(join(dir, 'codex', 'someone-else'), { recursive: true })
    mkdirSync(join(dir, 'codex', 'coach-kb-kb'), { recursive: true })
    writeFileSync(join(dir, 'codex', 'coach-kb-kb', 'SKILL.md'), 'not ours')

    const first = run('--codex', '--yes')
    expect(first.status).toBe(1) // 同名冲突要报出来
    expect(readFileSync(join(dir, 'codex', 'coach-kb-kb', 'SKILL.md'), 'utf8')).toBe('not ours')
    expect(existsSync(join(dir, 'codex', 'coach-kb-review', MARKER))).toBe(true)

    expect(run('--codex', '--yes').stdout).toContain('(没变)')

    expect(run('--codex', '--uninstall', '--yes').status).toBe(0)
    expect(readdirSync(join(dir, 'codex')).sort()).toEqual(['coach-kb-kb', 'someone-else'])
  })

  test('WorkBuddy 装的是 report 而不是 review', () => {
    expect(run('--workbuddy', '--yes').status).toBe(0)
    const names = readdirSync(join(dir, 'wb')).sort()
    expect(names).toEqual(['coach-kb-coach', 'coach-kb-due', 'coach-kb-kb', 'coach-kb-recall', 'coach-kb-report', 'coach-kb-save'])
  })
})

describe('coach install --cursor', () => {
  let dir: string
  const run = (...argv: string[]) =>
    spawnSync('bun', [CLI, 'install', ...argv], {
      env: { ...process.env, COACH_PLUGIN_DIR: PLUGIN, COACH_CURSOR_SKILLS: join(dir, 'cursor') },
      encoding: 'utf8',
    })
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'coach-cursor-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('一条命令装齐:report 代替 review,带 recall', () => {
    const r = run('--cursor', '--yes')
    expect(r.status).toBe(0)
    expect(readdirSync(join(dir, 'cursor')).sort()).toEqual([
      'coach-kb-coach', 'coach-kb-due', 'coach-kb-kb', 'coach-kb-recall', 'coach-kb-report', 'coach-kb-save',
    ])
  })

  test('report 的来源记成 cursor,文案里不留 WorkBuddy,不留插件变量', () => {
    run('--cursor', '--yes')
    const md = readFileSync(join(dir, 'cursor', 'coach-kb-report', 'SKILL.md'), 'utf8')
    expect(md).toContain('--host cursor')
    expect(md).not.toContain('WorkBuddy')
    for (const n of readdirSync(join(dir, 'cursor'))) {
      const body = readFileSync(join(dir, 'cursor', n, 'SKILL.md'), 'utf8')
      expect(body, n).not.toContain('CLAUDE_PLUGIN_ROOT')
      expect(body, n).not.toContain('{{COACH}}')
      expect(body, n).not.toContain('allowed-tools')
      expect(body, n).toMatch(/^name: coach-kb-/m)
    }
  })

  test('卸载只撤自己的', () => {
    run('--cursor', '--yes')
    mkdirSync(join(dir, 'cursor', 'impeccable'), { recursive: true })
    expect(run('--cursor', '--uninstall', '--yes').status).toBe(0)
    expect(readdirSync(join(dir, 'cursor'))).toEqual(['impeccable'])
  })
})

describe('coach report', () => {
  let kb: string
  beforeEach(() => {
    kb = mkdtempSync(join(tmpdir(), 'coach-report-'))
  })
  afterEach(() => rmSync(kb, { recursive: true, force: true }))

  const report = (input: string, ...argv: string[]) =>
    spawnSync('bun', [CLI, 'report', '--kb', kb, '--session', 's1', ...argv], { input, encoding: 'utf8' })

  test('落成 inbox 卡,来源 workbuddy,mine 为空;重复上报不加卡', () => {
    const one = JSON.stringify({ title: '别名没生效', type: 'pitfall', evidence: ['tsconfig.json:5'], ai: 'paths 要配 baseUrl' })
    expect(report(one).status).toBe(0)
    expect(report(`[${one}]`).status).toBe(0)
    const cards = loadCards(kb).map(c => c.card)
    expect(cards.length).toBe(1)
    const c = cards[0]
    expect(c?.status).toBe('inbox')
    expect(c?.source.tool).toBe('workbuddy')
    expect(c?.mine).toBe('')
    expect(c?.evidence).toEqual(['tsconfig.json:5'])
  })

  test('疑似密钥拒绝落盘;坏 JSON 退出码 2', () => {
    const r = report(JSON.stringify({ title: 'x', evidence: ['sk-ant-api03-' + 'a'.repeat(90)] }))
    expect(r.status).toBe(1)
    expect(loadCards(kb).length).toBe(0)
    expect(report('{oops').status).toBe(2)
  })
})
