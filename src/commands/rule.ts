// `coach rule` —— 把卡片里那些**只对这个项目成立**的经验，回写进项目自己的
// `CLAUDE.md` / `AGENTS.md`。
//
// 为什么要有这一步：知识库（`~/knowledge`）记的是「你会什么」，跟着你走；
// 而「这个项目的鉴权中间件要先确认挂载顺序」是**项目属性**，它该跟项目走 ——
// 换台机器 clone 下来，下一个人（或者下一个会话的你）也应该看到它。
//
// ★ 四个动作，边界必须清楚：
//
//   propose    卡片 → inbox/rules-<date>.md（**只写进你自己的知识库**，不动项目）
//   apply      写进项目文件（**默认只预演**，--yes 才动）
//   uninstall  撤回来（默认只预演）
//   --self-test 幂等断言，不碰任何文件
//
// propose 默认就落盘、apply 默认不落盘 —— 看着不一致，其实是同一条规则：
// **会动别人仓库的动作要 --yes，只动自己知识库的不需要。**
// `install` 和 `brain enable` 也是按同一条线切的。

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Card } from '../core/card.ts'
import { slugify } from '../core/ids.ts'
import { loadCards } from '../core/kb.ts'
import { beginMark, endMark, stamp, unstamp } from '../core/mark.ts'
import { saveState, today } from '../core/state.ts'
import type { Ctx } from './ctx.ts'

/** 这一段在项目文件里的 tag。stamp 靠它认出自己上一轮写的东西。 */
const TAG = 'coach-kb'

/** 一次最多回写几条。CLAUDE.md 每次会话都进上下文，块头太长就是在收税。 */
const MAX_RULES = 8

/** 规则正文里单条最多多少字。超了就截 —— 细节在卡片里，这里是指路牌。 */
const RULE_MAX_CHARS = 100

export async function runRule(ctx: Ctx): Promise<number> {
  const { args } = ctx

  // 动词从**位置参数**读（`coach rule apply`），跟 `brain` 一致 ——
  // 不读的话 `coach rule apply --cwd X` 会静默退化成 `propose`，
  // 也就是「想写进项目，结果往知识库里写了一份规则清单」。
  // 那是一次真实的误伤：命令看着跑成功了，动的地方不是你要的那个。
  // 旗标形式（--apply/--uninstall/--self-test）保留，方便脚本里用。
  const verb =
    args.positional[0] ??
    (args.bool('self-test')
      ? 'self-test'
      : args.bool('check')
        ? 'check'
        : args.bool('apply')
          ? 'apply'
          : args.bool('uninstall') || args.bool('remove')
            ? 'uninstall'
            : 'propose')

  switch (verb) {
    case 'self-test':
    case 'selftest':
      return selfTest(ctx)
    case 'propose':
      return propose(ctx)
    // `apply --check` 与 `check` 是同一条路：都只是预演，都不写。
    case 'check':
      return apply(ctx, { checkOnly: true })
    case 'apply':
      return apply(ctx, { checkOnly: args.bool('check') })
    case 'uninstall':
    case 'remove':
      return uninstall(ctx)
    default:
      // 拼错的动词**不许退化**成默认动作。默认动作会写文件。
      ctx.err(`✗ 不认识 rule ${verb}。可用:propose / apply / check / uninstall / --self-test`)
      return 2
  }
}

// ---------------------------------------------------------------------------
// 挑规则
// ---------------------------------------------------------------------------

export interface Rule {
  cardId: string
  title: string
  /** 回写进项目文件的那一行（已经压平、截断）。 */
  line: string
  /** 这条规则在几个不同会话里出现过。≥2 就是「反复踩的」。 */
  sessions: number
  cwd: string
  date: string
}

/**
 * 从卡片里挑出可回写的规则。**全是确定性判断，不请模型。**
 *
 * 三个门槛，每一个都在挡一种具体的失败：
 *
 *   1. `status === 'confirmed'` —— 只有用户亲手认过的卡才算。
 *      否则等于把 AI 摘要写进一个每次会话都要加载的文件里，而那正是
 *      这个项目最想避免的东西。
 *   2. 有可执行的那一行（`transfer` 优先，退回 `mine`）。
 *      一条说不出「下次先做什么」的卡，写进 CLAUDE.md 只是噪音。
 *   3. `cwd` 匹配（`--cwd` 给了的时候）。**跨项目的规则不许互相污染** ——
 *      A 项目的中间件顺序写进 B 项目的 CLAUDE.md 是负价值。
 *
 * 排序按「几个不同会话里出现过」降序 —— 反复踩的排前面，这也是唯一
 * 能证明它值得占位的证据。
 */
export function pickRules(cards: Card[], opts: { cwd?: string; max?: number } = {}): Rule[] {
  const wantCwd = opts.cwd === undefined ? undefined : resolve(opts.cwd)

  // 「同一件事在几个会话里出现过」按标题数。同一天的两个会话也算两次 ——
  // 那确实是两次独立的踩坑。标题是 CLI 从证据里抠的，同一签名必得同一标题。
  const byTitle = new Map<string, Set<string>>()
  for (const c of cards) {
    const set = byTitle.get(c.title) ?? new Set<string>()
    if (c.source.session !== '') set.add(c.source.session)
    byTitle.set(c.title, set)
  }

  const out: Rule[] = []
  for (const c of cards) {
    if (c.status !== 'confirmed') continue
    const cwd = c.source.cwd === '' ? '' : resolve(c.source.cwd)
    if (wantCwd !== undefined && cwd !== wantCwd) continue

    const line = ruleLine(c)
    if (line === '') continue

    out.push({
      cardId: c.id,
      title: c.title,
      line,
      sessions: byTitle.get(c.title)?.size ?? 0,
      cwd,
      date: c.source.date,
    })
  }

  out.sort((a, b) => b.sessions - a.sessions || b.date.localeCompare(a.date) || a.cardId.localeCompare(b.cardId))
  return out.slice(0, opts.max ?? MAX_RULES)
}

/**
 * 一条规则的那个单行。
 *
 * `transfer`（「下次这类问题的第一步」）优先 —— 它本来就是**为这个用途设计的字段**。
 * 没有就退回 `mine`（用户原话）。两者都没有就**不出规则**，而不是拿 `ai`
 * 那一节凑数：那是 AI 的散文，写进 CLAUDE.md 就变成 AI 在给未来的你下指令。
 */
export function ruleLine(card: Card): string {
  const raw = firstSentence(card.transfer !== '' ? card.transfer : card.mine)
  if (raw === '') return ''
  const cut = raw.length <= RULE_MAX_CHARS ? raw : raw.slice(0, RULE_MAX_CHARS - 1) + '…'
  return `${card.title} —— ${cut}`
}

/** 取第一句。规则的载体是一行，整段塞进去会让 CLAUDE.md 变成散文集。 */
function firstSentence(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  // 按句号/问号/感叹号切（含全角）。切不出来就整句用。
  const m = /^(.{8,}?[。．.！!？?])/.exec(flat)
  return (m?.[1] ?? flat).trim()
}

/** `inbox/rules-<date>.md` 的正文。按项目分组 —— 一张卡不知道属于谁就没法用。 */
export function renderRulesFile(rules: Rule[], day: string): string {
  const lines: string[] = []
  lines.push(`# 建议固化进项目的规则（${day}）`)
  lines.push('')
  lines.push('这些都是你**已经认过**的卡（`status: confirmed`）。下面是按项目分好的：')
  lines.push('`coach rule apply --cwd <项目> --check` 先预演，确认了再加 `--yes`。')
  lines.push('')

  if (rules.length === 0) {
    lines.push('(没有可回写的规则 —— 要么还没有确认过的卡，要么那些卡都还没写')
    lines.push('「下次这类问题的第一步」。**空着是正常的**，不必凑。)')
    return lines.join('\n') + '\n'
  }

  const groups = new Map<string, Rule[]>()
  for (const r of rules) {
    const key = r.cwd === '' ? '' : r.cwd
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  // 有项目名的排前面，没归属的垫底
  const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))

  for (const key of keys) {
    lines.push(`## ${key === '' ? '(卡片里没记项目目录)' : key}`)
    lines.push('')
    if (key === '') {
      lines.push('这些卡没带 `cwd`（多半是别处写进来的），`rule apply` 认不出该写进哪个项目。')
      lines.push('要回写的话先 `coach save` 补一张带项目目录的卡。')
      lines.push('')
    }
    for (const r of groups.get(key) ?? []) {
      const mark = r.sessions >= 2 ? `（${r.sessions} 个会话里都出现过）` : ''
      lines.push(`- ${r.line}${mark}`)
      lines.push(`  \`${r.cardId}\``)
    }
    lines.push('')
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// propose
// ---------------------------------------------------------------------------

/**
 * `inbox/rules-<date>.md` 的落点。
 *
 * ★ 带了 `--cwd` 就按项目分文件。共用一份的话，`propose --cwd B` 会把
 *   `propose --cwd A` 刚写的那份**整份盖掉** —— 而那份正是你刚要看的。
 *   坏法是静的：文件看着好好的，只是里面的规则换成了别的项目的。
 *   同一天重跑同一个项目仍然是覆盖自己那一份，幂等性不受影响。
 */
export function rulesPath(ctx: Ctx, day: string, cwd: string | undefined): string {  if (cwd === undefined) return join(ctx.paths.inbox, `rules-${day}.md`)
  return join(ctx.paths.inbox, `rules-${day}-${slugify(resolve(cwd))}.md`)
}

async function propose(ctx: Ctx): Promise<number> {
  const { args, out, err } = ctx
  const cards = allCards(ctx)
  const cwd = args.get('cwd')
  const rules = pickRules(cards, { ...(cwd === undefined ? {} : { cwd }), max: args.num('limit', MAX_RULES) })

  const day = today()
  const body = renderRulesFile(rules, day)
  const path = rulesPath(ctx, day, cwd)

  out(`coach rule propose${cwd === undefined ? '' : `  --cwd ${resolve(cwd)}`}`)
  out('')
  out(`  扫了 ${cards.length} 张卡，其中 ${cards.filter(c => c.status === 'confirmed').length} 张已确认`)
  out(`  挑出 ${rules.length} 条可回写的规则`)
  out('')

  if (args.bool('dry-run')) {
    out(body)
    out('(--dry-run，没写文件)')
    return 0
  }

  // 同一天重跑覆盖自己那份，不追加 —— 幂等的意思就是重复跑不产生第二份。
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null
  if (before === body) {
    out(`· ${path} 未变（同名文件内容一致）`)
    return 0
  }
  mkdirSync(ctx.paths.inbox, { recursive: true, mode: 0o700 })
  writeFileSync(path, body, { mode: 0o600 })
  out(`${before === null ? '＋ 写入' : '↻ 更新'} ${path}`)
  out('')

  if (rules.length === 0) {
    err('⚠ 这次一条规则都没有。**不要因此去写一张没有「下一步」的卡** ——')
    err('  规则是认领之后的副产品，不是要凑出来的指标。')
    return 0
  }
  out('看一眼那份文件，然后：coach rule apply --cwd <项目> --check')
  return 0
}

// ---------------------------------------------------------------------------
// apply / uninstall
// ---------------------------------------------------------------------------

/**
 * 这个项目该写进哪几个文件。
 *
 * **只写已经存在的那个（那几个）。** 一个只用 Claude Code 的项目不该因为我们
 * 回写一条规则就凭空多出一个 `AGENTS.md` —— 那是往别人仓库里塞文件。
 * 两个都在就两个都写：双工具的项目，规则该被两边都看到。
 * 都不在才新建 `CLAUDE.md`（此时我们是被明确要求写的）。
 */
export function targetsFor(cwd: string, forced?: string): string[] {
  if (forced !== undefined) return [resolve(forced)]
  const cands = [join(cwd, 'CLAUDE.md'), join(cwd, 'AGENTS.md')].filter(p => existsSync(p))
  return cands.length > 0 ? cands : [join(cwd, 'CLAUDE.md')]
}

/** 项目文件里那一段的正文。**短。** 每次会话都进上下文的东西。 */
export function renderRuleBlock(rules: Rule[]): string {
  const lines: string[] = []
  lines.push('## 这个项目里我踩过的坑')
  lines.push('')
  lines.push('来自 `~/knowledge` 里**你自己确认过**的卡片。每条的详细版在知识库里，看 id 就能找：')
  lines.push('`coach kb --show <id>`。')
  lines.push('')
  for (const r of rules) {
    lines.push(`- ${r.line}  \`${r.cardId}\``)
  }
  return lines.join('\n')
}

function apply(ctx: Ctx, opts: { checkOnly?: boolean } = {}): number {
  const { args, out, err } = ctx
  const cwdArg = args.get('cwd')
  const cwd = resolve(cwdArg ?? process.cwd())
  const dry = opts.checkOnly === true || (!args.bool('yes') && !args.bool('i-know'))

  const cards = allCards(ctx)
  const rules = pickRules(cards, { cwd, max: args.num('limit', MAX_RULES) })
  const targets = targetsFor(cwd, args.get('file'))

  out(`coach rule apply  --cwd ${cwd}${dry ? '  (预演 —— 什么都没改)' : ''}`)
  out('')
  out(`  候选 ${rules.length} 条（这个项目里已确认的卡）`)
  for (const t of targets) out(`  目标 ${t}${existsSync(t) ? '' : '  (不存在,会新建)'}`)
  out('')

  if (rules.length === 0) {
    err('  没有可回写的规则。先 `coach save` 认下几张这个项目的卡，')
    err('  并且卡里要有「下次这类问题的第一步」。')
    return 0
  }
  for (const r of rules) out(`  · ${r.line}`)
  out('')

  let changedAny = false
  for (const t of targets) {
    const before = existsSync(t) ? readFileSync(t, 'utf8') : ''
    const { text, changed } = stamp(before, renderRuleBlock(rules), TAG)
    if (!changed) {
      out(`  · ${t} 未变`)
      continue
    }
    changedAny = true
    if (dry) {
      out(`  ⇢ ${t} 会变（+${text.length - before.length} 字符）`)
      continue
    }
    // 保留原有权限位：别人的 CLAUDE.md 可能是 0644，我们不该顺手改成 0600
    const mode = existsSync(t) ? statSync(t).mode & 0o777 : 0o644
    writeText(t, text, mode)
    out(`  ↻ ${t} 已更新`)
  }

  out('')
  if (dry) {
    out('确认无误就跑:coach rule apply --cwd ' + cwd + ' --yes')
    out('撤回随时可以:coach rule uninstall --cwd ' + cwd)
    return 0
  }
  ctx.state.install.slots[TAG] = targets.join(',')
  saveState(ctx.kb, ctx.state)
  out(changedAny ? '✓ 写好了。`git diff` 看一眼，不满意就 coach rule uninstall --cwd ' + cwd : '✓ 已经是最新的，没动文件。')
  return 0
}

function uninstall(ctx: Ctx): number {
  const { args, out } = ctx
  const cwd = resolve(args.get('cwd') ?? process.cwd())
  const dry = !args.bool('yes') && !args.bool('i-know')
  const targets = targetsFor(cwd, args.get('file'))

  out(`coach rule uninstall  --cwd ${cwd}${dry ? '  (预演 —— 什么都没改)' : ''}`)
  out('')

  let touched = 0
  for (const t of targets) {
    if (!existsSync(t)) {
      out(`  · ${t} 不存在`)
      continue
    }
    const before = readFileSync(t, 'utf8')
    const { text, changed } = unstamp(before, TAG)
    if (!changed) {
      out(`  · ${t} 里没有我们的段落（没动过，或已经撤过）`)
      continue
    }
    touched += 1
    if (dry) {
      out(`  ⇢ ${t} 会撤回 ${before.length - text.length} 字符`)
      continue
    }
    const mode = statSync(t).mode & 0o777
    writeText(t, text, mode)
    out(`  ↻ ${t} 已撤回`)
  }

  out('')
  if (dry) {
    if (touched > 0) out('要真撤，加 --yes:coach rule uninstall --cwd ' + cwd + ' --yes')
    else out('没什么可撤的。')
    return 0
  }
  out(touched > 0
    ? '✓ 撤完了。`git diff` 应该是干净的 —— 我们自己带进去的空行也一起收走了。'
    : '✓ 没什么可撤的。')
  return 0
}

// ---------------------------------------------------------------------------

/**
 * `--self-test` —— 只断言，不碰任何文件。
 *
 * 这里测的三条都是「坏法是静默的」那类：
 *   · 写两遍长出两份 → 每次 apply 都在别人仓库里多一段
 *   · 撤回后留下空行 → 「卸载后 git diff 干净」不成立，而人会以为是自己改的
 *   · 段落里有字面量 `..` → 与 mark 的路径无关，但会让人怀疑我们在搞路径穿越
 */
function selfTest(ctx: Ctx): number {
  const { out, err } = ctx
  let bad = 0
  const sample = renderRuleBlock([
    { cardId: 'kb-2026-01-01-pitfall-x', title: '反复踩的坑', line: '反复踩的坑 —— 先看日志', sessions: 2, cwd: '/tmp/p', date: '2026-01-01' },
  ])

  const once = stamp('# 项目\n', sample, TAG).text
  const twice = stamp(once, sample, TAG).text
  if (once === twice) out('  ✓ 同一个段落写两遍不会长出第二份')
  else {
    bad += 1
    err('  ✗ 重复 stamp 不幂等 —— 每次 apply 都会往项目文件里多加一段')
  }

  const back = unstamp(once, TAG).text
  if (back === '# 项目\n') out('  ✓ 撤回后逐字节回到原样（git diff 会干净）')
  else {
    bad += 1
    err(`  ✗ 撤回后残留:${JSON.stringify(back)}`)
  }

  // 别人的内容不许被动。这是最要命的一条 —— 我们改的是别人的仓库。
  const theirs = '# 项目\n\n## 我们的约定\n\n- 不许 force push\n'
  const after = unstamp(stamp(theirs, sample, TAG).text, TAG).text
  if (after === theirs) out('  ✓ 已有内容一个字符都没动')
  else {
    bad += 1
    err('  ✗ 撤回后原有内容变了 —— 这个 bug 会直接改坏别人的 CLAUDE.md')
  }

  if (beginMark(TAG).includes('coach rule uninstall')) out('  ✓ 段落里的卸载提示指向真实存在的命令')
  else {
    bad += 1
    err('  ✗ 段落里的卸载提示不是 `coach rule uninstall` —— 用户照着敲会撞墙')
  }

  const blocks = [beginMark(TAG), endMark(TAG), sample].join('\n')
  if (!/\n\s*\.\.\s*(\n|$)/.test(blocks) && !blocks.includes('../')) out('  ✓ 段落里没有路径穿越写法')
  else {
    bad += 1
    err('  ✗ 段落里出现了 `..` 路径写法')
  }

  out('')
  if (bad === 0) {
    out('✓ 自检通过。')
    return 0
  }
  err(`✗ ${bad} 项没过。`)
  return 1
}

/** 知识库里的全部卡片。`loadCards` 返回的是带路径的定位信息，这里只要卡片本身。 */
function allCards(ctx: Ctx): Card[] {
  return loadCards(ctx.kb).map(l => l.card)
}

/**
 * 保留原有权限位再写回。
 *
 * 别人的 `CLAUDE.md` 可能是 0644，我们不该因为回写一条规则就把它变成 0600 ——
 * 那会让同组的人读不到，而 `git diff` 里看不出任何异常。
 */
function writeText(path: string, text: string, mode: number): void {
  writeFileSync(path, text, { mode })
}
