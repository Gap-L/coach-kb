// 插件的安装面测试。
//
// 这里测的东西有一个共同点:**它们的坏法都是静默的**。
//   · SKILL.md 缺 frontmatter   → /coach-kb:review 这个命令根本不存在,但没人报错
//   · name 和目录名对不上        → 命令名和你以为的不一样
//   · allowed-tools 没覆盖正文里的命令 → 流程走到一半卡在权限询问上
//   · bundle 没进 plugin/dist/  → 本地路径装能跑,同事从 git 装就静默失效
// 每一条都值得钉住,因为「装好了但不生效」是这个项目最贵的失败模式。

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configIsStable, skillFiles } from '../src/commands/install.ts'

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..')
const PLUGIN = join(ROOT, 'plugin')
const SKILL_NAMES = ['review', 'coach', 'save', 'kb', 'due']

function skillSource(name: string): { front: string; body: string } {
  const md = readFileSync(join(PLUGIN, 'skills', name, 'SKILL.md'), 'utf8')
  const end = md.indexOf('\n---', 4)
  return { front: md.slice(0, end === -1 ? md.length : end), body: end === -1 ? '' : md.slice(end) }
}

/** frontmatter 里 `allowed-tools:` 下面那些 `- Bash(...)` 条目。 */
function allowedTools(front: string): string[] {
  const out: string[] = []
  let inBlock = false
  for (const line of front.split('\n')) {
    if (/^allowed-tools:\s*$/.test(line)) {
      inBlock = true
      continue
    }
    if (!inBlock) continue
    const m = /^\s+-\s+(.+)$/.exec(line)
    if (m !== null && m[1] !== undefined) out.push(m[1].trim())
    else if (line.trim() !== '') inBlock = false
  }
  return out
}

describe('每个 skill 文件本身', () => {
  test('都在,且带 frontmatter', () => {
    for (const s of skillFiles(PLUGIN)) {
      expect({ name: s.name, ok: s.ok }).toEqual({ name: s.name, ok: true })
    }
  })

  test('name 字段和目录名一致 —— 否则 /coach-kb:<名字> 就不是你想的那个', () => {
    for (const name of SKILL_NAMES) {
      const { front } = skillSource(name)
      expect(front).toMatch(new RegExp(`^name:\\s*${name}\\s*$`, 'm'))
    }
  })

  test('都有 description —— 没有它,模型不知道什么时候该用这个 skill', () => {
    for (const name of SKILL_NAMES) {
      const { front } = skillSource(name)
      const m = /^description:\s*(.+)$/m.exec(front)
      expect(m, `${name} 缺 description`).not.toBeNull()
      expect((m?.[1] ?? '').length, `${name} 的 description 太短,起不到触发作用`).toBeGreaterThan(10)
    }
  })
})

describe('allowed-tools 和正文对得上', () => {
  // ★ 这条是这组测试里最值钱的。
  //
  // skill 的正文是给模型看的指令,`allowed-tools` 是**权限**。
  // 两者一脱节,表现是:模型照着正文去跑,然后停下来问用户要权限 ——
  // 而用户此时正看着一个"教练"卡在半路。
  // 曾经就是这样:save 的正文让人去跑 `kb --confirm`,而 save 只放行了 `save ...`。
  test('正文里出现的每个 coach 子命令,都被本 skill 放行了', () => {
    for (const name of SKILL_NAMES) {
      const { front, body } = skillSource(name)
      const rules = allowedTools(front)
      expect(rules.length, `${name} 没有 allowed-tools,正文里的命令都会弹权限询问`).toBeGreaterThan(0)

      const used = new Set<string>()
      for (const m of body.matchAll(/coach\.mjs\s+([a-z-]+)/g)) {
        if (m[1] !== undefined) used.add(m[1])
      }
      expect(used.size, `${name} 的正文里没提到任何 coach 命令?`).toBeGreaterThan(0)

      for (const sub of used) {
        const covered = rules.some(r => r.includes(`coach.mjs ${sub}`))
        expect(covered, `${name} 的正文用了 \`coach ${sub}\`,但 allowed-tools 没放行它`)
          .toBe(true)
      }
    }
  })

  // 正文和 allowed-tools 里的路径变量必须**逐字相同**。
  // ${CLAUDE_PLUGIN_ROOT} 在两边都会被替换成同一个绝对路径,权限规则才匹配得上;
  // 一边写 ${CLAUDE_PLUGIN_ROOT}、另一边写死一个路径,规则就永远不命中。
  test('正文与 allowed-tools 用的是同一个 ${CLAUDE_PLUGIN_ROOT}', () => {
    for (const name of SKILL_NAMES) {
      const { front, body } = skillSource(name)
      expect(body, `${name} 正文没用到 ${'${CLAUDE_PLUGIN_ROOT}'}`).toContain('${CLAUDE_PLUGIN_ROOT}')
      for (const r of allowedTools(front)) {
        expect(r, `${name} 的规则没用同一个变量:${r}`).toContain('${CLAUDE_PLUGIN_ROOT}/dist/coach.mjs')
      }
    }
  })

  test('没有 skill 把路径写成相对路径或 ../ —— 那在安装到缓存后必定失效', () => {
    for (const name of SKILL_NAMES) {
      const { front, body } = skillSource(name)
      const all = front + body
      // 只查命令里的路径写法,不查散文说明里提到的 plugin/dist 之类
      for (const m of all.matchAll(/node\s+(\S+)/g)) {
        const p = m[1] ?? ''
        if (!p.includes('coach.mjs') && !p.includes('hook.mjs')) continue
        expect(p, `${name} 里的 node 路径应以 ${'${CLAUDE_PLUGIN_ROOT}'} 开头:${p}`)
          .toStartWith('${CLAUDE_PLUGIN_ROOT}')
      }
    }
  })
})

describe('插件自包含', () => {
  test('bundle 在 plugin/dist/ 里,不在 ../dist —— 从 git 装时只拷插件目录', () => {
    for (const f of ['dist/hook.mjs', 'dist/coach.mjs']) {
      expect(existsSync(join(PLUGIN, f)), `缺 ${f},插件装到别人机器上会静默失效`).toBe(true)
    }
  })

  test('hooks.json 是插件格式(有顶层 hooks),不是旧 dev-mod 的 {modules:[…]}', () => {
    const parsed = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8')) as {
      hooks?: Record<string, unknown[]>
    }
    expect(parsed.hooks).toBeDefined()
    // 只挂 UserPromptSubmit。Stop 上那条是**故意不挂的** ——
    // 用户在需求里明确排除了「会话结束自动复盘」,而 Stop 的普通 stdout
    // 根本到不了模型(只进 debug log),要说话就得用 additionalContext,
    // 那就等于把被排除的东西偷偷加回来。见 docs/design.md。
    expect(Object.keys(parsed.hooks ?? {})).toEqual(['UserPromptSubmit'])
  })

  test('没有任何组件路径带 ..(validate 会判为路径穿越)', () => {
    const files = readdirSync(PLUGIN, { recursive: true }) as string[]
    expect(files.length).toBeGreaterThan(0)
    const manifest = readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')
    expect(manifest).not.toContain('..')
  })
})

describe('安装的幂等前提', () => {
  test('默认配置渲染稳定且是合法 JSON —— 重装不会写坏它', () => {
    expect(configIsStable()).toBe(true)
  })
})
