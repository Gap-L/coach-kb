// `coach brain` —— 选哪个脑、花多少钱、现在可用不可用。
//
// 这个命令存在的理由很具体:**默认是 none,而且必须由你亲手打开。**
//
// 把会话喂给 `claude -p` 等于外发 —— 实测那台自定义端点跑在 deepseek-flash
// 上,不是 Anthropic 官方模型。这件事必须是一个**有意识的动作**,
// 不能是「装完就默认发生」。所以 enable 要带 --yes,bench 也要带 --yes
// (它一样会花钱)。
//
// bench 的实测结果是后面所有设计的依据:`claude -p` 一次调用的固定开销
// 九成来自 agentic 运行时本身,砍不掉。既然如此,唯一的杠杆就是
// **少调用 + 每次多干活** —— 这就是 distill 批量化处理整场会话的原因。

import { spawn } from 'node:child_process'
import { BRAIN_NAMES, getBrain, isBrainName } from '../brain/index.ts'
import { readResultPayload } from '../brain/json.ts'
import { sentinelEnv } from '../brain/types.ts'
import { saveState, today } from '../core/state.ts'
import type { Ctx } from './ctx.ts'

/** 禁掉全部工具 —— 蒸馏不需要任何工具。与 brain/claude.ts 里那份保持一致。 */
const DISALLOWED = [
  'Bash', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'KillShell', 'BashOutput', 'SlashCommand',
].join(',')

export async function runBrain(ctx: Ctx): Promise<number> {
  const sub = ctx.args.positional[0] ?? 'status'
  switch (sub) {
    case 'status':
      return status(ctx)
    case 'enable':
      return enable(ctx)
    case 'disable':
      return disable(ctx)
    case 'bench':
      return bench(ctx)
    default:
      ctx.err(`✗ 不认识 brain ${sub}。可用:status / enable / disable / bench`)
      return 2
  }
}

// ---------------------------------------------------------------------------

async function status(ctx: Ctx): Promise<number> {
  const { out } = ctx
  const b = ctx.state.brain
  out(`选定的脑:${b.chosen}${b.enabled ? '' : '  ⚠ 未启用(实际按 none 运行)'}`)
  out(`每日上限:$${b.maxUsdPerDay}`)
  const spent = ctx.state.digest.spentDate === today() ? ctx.state.digest.spentTodayUsd : 0
  out(`今日已花:$${spent.toFixed(4)}`)
  if (spent > 0) out(`(记账是估算值,以端点账单为准)`)

  const last = ctx.state.digest.lastRunAt
  out(`知识库:${ctx.kb}`)
  if (last !== undefined) out(`上次 digest:${last}`)
  out('')
  out('可用性:')
  for (const name of BRAIN_NAMES) {
    if (name === 'none') {
      out('  none     ✓ 永远可用(不调模型,只产骨架卡)')
      continue
    }
    const probe = await getBrain(name).probe()
    out(`  ${name.padEnd(8)} ${probe.ok ? '✓' : '✗'} ${probe.detail}`)
  }
  if (b.bench !== undefined) {
    out('')
    out(`上次 bench:${String(b.bench['at'] ?? '?')}`)
  }
  return 0
}

function enable(ctx: Ctx): number {
  const { args, out, err } = ctx
  const name = args.positional[1] ?? args.get('brain') ?? 'claude'
  if (!isBrainName(name) || name === 'none') {
    err(`✗ 不认识的脑 ${name}。可用:claude / codex / http(或用 disable 关掉)`)
    return 2
  }
  if (!args.bool('yes') && !args.bool('i-know')) {
    err(`⚠ 启用 ${name} 意味着:从今往后的复盘会把会话内容发给它。`)
    err(`  实测本机 ${name} 走的是自定义端点(不是 Anthropic 官方),内容会离开本机。`)
    err('  确认要开,就加 --yes:coach brain enable ' + name + ' --yes')
    return 2
  }
  ctx.state.brain.chosen = name
  ctx.state.brain.enabled = true
  saveState(ctx.kb, ctx.state)
  out(`✓ 脑已切到 ${name}`)
  out('  --no-llm / --brain none 随时可以单次关掉它。')
  return 0
}

function disable(ctx: Ctx): number {
  ctx.state.brain.enabled = false
  ctx.state.brain.chosen = 'none'
  saveState(ctx.kb, ctx.state)
  ctx.out('✓ 脑已关。之后的复盘只产骨架卡,不调模型、不外发任何东西。')
  return 0
}

// ---------------------------------------------------------------------------
// bench
// ---------------------------------------------------------------------------

interface Combo {
  label: string
  args: string[]
}

/**
 * 四档参数。第一档是「什么都不加」—— 必须留着它,
 * 否则整张表就没有基准,也就看不出后面几档到底省了多少。
 */
const COMBOS: Combo[] = [
  { label: '(不加参数)', args: [] },
  { label: '--strict-mcp-config --settings {} --max-turns 1', args: ['--strict-mcp-config', '--settings', '{}', '--max-turns', '1'] },
  { label: '＋ --setting-sources ""', args: ['--strict-mcp-config', '--settings', '{}', '--max-turns', '1', '--setting-sources', ''] },
  {
    label: '＋ --disallowedTools …',
    args: ['--strict-mcp-config', '--settings', '{}', '--max-turns', '1', '--setting-sources', '', '--disallowedTools', DISALLOWED],
  },
]

async function bench(ctx: Ctx): Promise<number> {
  const { args, out, err } = ctx

  if (args.bool('json')) {
    out(JSON.stringify(ctx.state.brain.bench ?? null, null, 2))
    return 0
  }

  if (!args.bool('yes')) {
    err('bench 会真的调用 claude 若干次,按实测每档约 $0.02–0.23,合计约 $0.4。')
    err('想跑就加 --yes:coach brain bench --yes')
    err('（已有的实测结果:coach brain status / 见 src/brain/claude.ts 文件头）')
    return 2
  }

  const probe = await getBrain('claude').probe()
  if (!probe.ok) {
    err(`✗ claude 不可用:${probe.detail}`)
    return 1
  }
  out(`claude:${probe.detail}`)
  out('跑 4 档参数,每档一次空转调用(提示词只有几个 token,量的就是固定开销):')
  out('')

  const rows: Array<{ label: string; input: number; output: number; cost: number; ms: number; note?: string }> = []
  for (const combo of COMBOS) {
    const r = await one(ctx, combo)
    rows.push({ label: combo.label, ...r })
    out(`  ${combo.label.padEnd(52)} in ${String(r.input).padStart(6)}  $${r.cost.toFixed(4)}  ${r.ms}ms${r.note === undefined ? '' : `  ${r.note}`}`)
  }

  const base = rows[0]
  if (base !== undefined && base.cost > 0) {
    const best = rows[rows.length - 1]
    if (best !== undefined) {
      const saved = (1 - best.cost / base.cost) * 100
      out('')
      out(`最优档比不加参数省 ${saved.toFixed(0)}% —— 这才是真正该省的地方。`)
      out('注意大头不是插件和技能,是 MCP server 的工具 schema(见 --strict-mcp-config)。')
    }
  }

  ctx.state.brain.bench = {
    at: new Date().toISOString(),
    rows: rows.map(r => ({ label: r.label, input: r.input, output: r.output, cost: r.cost, ms: r.ms })),
  }
  saveState(ctx.kb, ctx.state)
  return 0
}

/** 跑一档。提示词压到最短 —— 量的是固定开销,提示词本身不该成为变量。 */
function one(
  ctx: Ctx,
  combo: Combo,
): Promise<{ input: number; output: number; cost: number; ms: number; note?: string }> {
  const started = Date.now()
  return new Promise(resolve => {
    const argv = ['-p', '--output-format', 'json', ...combo.args, '回答一个字:好']
    const child = spawn('claude', argv, {
      cwd: ctx.kb,
      env: sentinelEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < 4 * 1024 * 1024) stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 16 * 1024) stderr += d.toString('utf8')
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ input: 0, output: 0, cost: 0, ms: Date.now() - started, note: `✗ 起不来` })
    })
    child.on('close', code => {
      clearTimeout(timer)
      const ms = Date.now() - started
      const payload = readResultPayload(stdout)
      if (payload === null || code !== 0) {
        resolve({ input: 0, output: 0, cost: 0, ms, note: `✗ 退出码 ${String(code)}` })
        return
      }
      resolve({
        input: payload.usage?.inputTokens ?? 0,
        output: payload.usage?.outputTokens ?? 0,
        cost: payload.usage?.costUsd ?? 0,
        ms,
      })
    })
  })
}
