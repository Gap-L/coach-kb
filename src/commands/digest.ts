// `coach digest` —— 一周的汇总。
//
// ★ 这个命令**默认一次模型都不调**，而且在被 LaunchAgent 定时调起时更是如此。
//
// 理由不是省钱，是**没人看着的时候不该花钱**。周一早上九点自动跑的东西，
// 如果它会去调一个 $0.23/次的端点，那么它的失败方式就是「某个月账单突然多了
// 几十块，而你不知道为什么」。而且定时任务出错时没人看得见 —— 一个不出声
// 的自动扣费是最糟的一类默认。所以：**digest 只做算术**。
//
// 它的原料全部已经在本机了：
//   · 卡片（`~/knowledge/cards`）—— 内容、日期、状态、属于哪个会话
//   · 状态文件 —— 哪几场会话什么时候蒸馏过、每天花了多少
// 一行都不用重扫会话日志，所以它跑起来是毫秒级的，可以放心定时。
//
// 「建议固化进项目的规则」这一节也**不请模型**：它只是把已经确认过、
// 而且带「下次第一步」的卡片挑出来。真正需要判断力的是「这条值不值得固化」，
// 而那个判断是**用户**做的 —— 我们只负责把候选摆好。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadCards } from '../core/kb.ts'
import { isoWeek, saveState, shiftDays, today } from '../core/state.ts'
import { pickRules, type Rule } from './rule.ts'
import type { Ctx } from './ctx.ts'
import type { Card } from '../core/card.ts'

/** 躺在 inbox 超过这么多天还没补「我自己的表述」，就单独点出来。 */
const STALE_DAYS = 7

export async function runDigest(ctx: Ctx): Promise<number> {
  const { args, out } = ctx

  // 窗口默认是「今天往回 7 天，含今天」。**含今天**是刻意的：
  // 周中随手跑一次也要看到今天的活；而定时那份的幂等由「内容没变就不重写」
  // 保证，不靠冻住窗口。
  const end = args.get('until') ?? today()
  const start = args.get('since') ?? shiftDays(end, -Math.max(1, args.num('days', 7)))
  const label = args.get('label') ?? weekLabel(end)

  const cards = loadCards(ctx.kb).map(l => l.card)
  const sections = buildSections(ctx, cards, start, end)
  const report = renderReport(sections, { start, end, label, kb: ctx.kb })

  out(report)

  if (args.bool('dry-run')) {
    out('(--dry-run，没写文件)')
    return 0
  }

  const path = join(ctx.paths.digests, `${label}.md`)
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null
  if (before === report) {
    out(`· ${path} 未变`)
  } else {
    mkdirSync(ctx.paths.digests, { recursive: true, mode: 0o700 })
    writeFileSync(path, report, { mode: 0o600 })
    out(`${before === null ? '＋ 写入' : '↻ 更新'} ${path}`)
  }

  ctx.state.digest.lastRunAt = new Date().toISOString()
  ctx.state.digest.lastReport = path
  saveState(ctx.kb, ctx.state)
  return 0
}

/** 文件名用的周标签。用窗口**结束**那天所在的 ISO 周 —— 周一早上跑出来的
 *  就是刚过去那一周的编号，正是人会说出口的那个说法（「这周」）。 */
export function weekLabel(endDate: string): string {
  const w = isoWeek(endDate)
  return `${w.year}-W${String(w.week).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// 报表结构
// ---------------------------------------------------------------------------

export interface DigestSections {
  /** 窗口内蒸馏过几场会话（来自 state，不是猜的）。 */
  distilledSessions: { sessionId: string; at: string }[]
  learned: Card[]
  recurring: { title: string; sessions: string[]; cards: Card[] }[]
  inbox: { card: Card; ageDays: number }[]
  rules: Rule[]
  spend: { total: number; byDate: [string, number][] }
}

export function buildSections(ctx: Ctx, cards: Card[], start: string, end: string): DigestSections {
  const inWindow = (d: string): boolean => d !== '' && d >= start && d <= end

  // 窗口内蒸馏过的会话。**这是覆盖率的诚实声明** ——
  // 如果这周一次都没跑过 distill，下面所有数字都只是「库里的存量」，
  // 而不是「这周学到的」。报表开头必须说清是哪一种。
  const distilledSessions = Object.values(ctx.state.sessions)
    .filter(s => inWindow(s.lastProcessedAt.slice(0, 10)))
    .map(s => ({ sessionId: s.path.split('/').pop()?.replace('.jsonl', '') ?? s.path, at: s.lastProcessedAt }))
    .sort((a, b) => a.at.localeCompare(b.at))

  const learned = cards.filter(c => inWindow(c.source.date))

  // 「同一个坑」按标题归组 —— 标题是 CLI 从证据里抠的，同一签名必得同一标题，
  // 所以这个归组是确定性的，不是猜的。要求 ≥2 个**不同会话**：
  // 同一天的两个会话算两次，那确实是两次独立的踩坑。
  const byTitle = new Map<string, Card[]>()
  for (const c of cards) byTitle.set(c.title, [...(byTitle.get(c.title) ?? []), c])
  const recurring = [...byTitle.entries()]
    .map(([title, group]) => ({
      title,
      sessions: [...new Set(group.map(c => c.source.session).filter(s => s !== ''))],
      cards: group,
    }))
    // 至少要有一张卡落在窗口内，否则它是「以前反复踩的」，不是「这周的」
    .filter(g => g.sessions.length >= 2 && g.cards.some(c => inWindow(c.source.date)))
    .sort((a, b) => b.sessions.length - a.sessions.length || a.title.localeCompare(b.title))

  const cutoff = shiftDays(end, -STALE_DAYS)
  const inbox = cards
    .filter(c => c.mine === '')
    .map(c => ({ card: c, ageDays: ageInDays(c.source.date, end) }))
    .sort((a, b) => b.ageDays - a.ageDays)

  const rules = pickRules(cards)

  const byDate = Object.entries(ctx.state.digest.spendByDate)
    .filter(([d]) => inWindow(d))
    .sort((a, b) => a[0].localeCompare(b[0]))
  const spend = { total: byDate.reduce((n, [, v]) => n + v, 0), byDate }

  return { distilledSessions, learned, recurring, inbox, rules, spend }
}

/** 距今多少天。日期坏了就当 0 —— 报表不该因为一张手改坏的卡而崩。 */
function ageInDays(dateStr: string, endDate: string): number {
  const a = Date.parse(`${dateStr}T00:00:00Z`)
  const b = Date.parse(`${endDate}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.max(0, Math.round((b - a) / 86400000))
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

export function renderReport(
  s: DigestSections,
  meta: { start: string; end: string; label: string; kb: string },
): string {
  const L: string[] = []
  const confirmed = s.learned.filter(c => c.status === 'confirmed')
  const pending = s.learned.filter(c => c.status !== 'confirmed')

  L.push(`# ${meta.label} 这一周`)
  L.push('')
  L.push(`${meta.start} → ${meta.end}  ·  ${meta.kb}`)
  L.push('')

  // ---- 覆盖率声明 ---------------------------------------------------------
  // 这句必须紧跟在窗口后面。没有它，下面「这周学到 0 条」会被读成
  // 「我这周什么也没学到」，而真实原因多半是「这周没跑过 distill」。
  if (s.distilledSessions.length === 0) {
    L.push('> ⚠ **这一周没有蒸馏过任何会话。** 下面的数字是知识库的**存量**，')
    L.push('> 不是这一周的产出 —— 别看串了。要补就跑 `coach distill --latest`。')
  } else {
    L.push(`> 这一周蒸馏过 **${s.distilledSessions.length}** 场会话：`)
    for (const d of s.distilledSessions) L.push(`> - \`${d.sessionId.slice(0, 8)}\`  ${d.at.slice(0, 16).replace('T', ' ')}`)
  }
  L.push('')

  // ---- 沉下来的 -----------------------------------------------------------
  L.push(`## 这一周沉下来的：${s.learned.length} 张`)
  L.push('')
  L.push(`**已确认 ${confirmed.length}**（你自己认过的） · **待认领 ${pending.length}**（还只是 AI 摘要）`)
  L.push('')
  if (s.learned.length === 0) {
    L.push('(窗口里没有卡。这不一定是坏事 —— 但如果这周明明干了不少活，')
    L.push('那更可能是 distill 没跑，而不是没什么可学。)')
    L.push('')
  } else {
    for (const c of s.learned) {
      const mark = c.status === 'confirmed' ? '✓' : '·'
      L.push(`- ${mark} **${c.title}**  \`${c.id}\``)
      if (c.mine !== '') L.push(`  > ${firstLine(c.mine)}`)
    }
    L.push('')
    L.push('（✓ = 你写了「我自己的表述」，· = 还没。这张表的价值不在条数，')
    L.push('而在 ✓ 有几个 —— 没有那句话的卡只是 AI 摘要。）')
    L.push('')
  }

  // ---- 反复踩的坑 ---------------------------------------------------------
  // 这一节是 digest 真正的理由：**单看一场会话看不见它**。
  L.push(`## 反复踩的同一个坑：${s.recurring.length} 个`)
  L.push('')
  if (s.recurring.length === 0) {
    L.push('(这一周没有跨会话重复出现的坑。这是好事。)')
    L.push('')
  } else {
    for (const g of s.recurring) {
      L.push(`### ${g.sessions.length} 次：${g.title}`)
      L.push('')
      for (const c of g.cards) {
        const paths = c.evidence.slice(0, 3).join(' / ')
        L.push(`- \`${c.source.session.slice(0, 8)}\`  ${c.source.date}  ${paths === '' ? '(无证据)' : paths}`)
      }
      L.push('')
    }
    L.push('同一件事撞了这么多次，值得的不是「记住它」，是改掉让它发生的那一步。')
    L.push('')
  }

  // ---- 还躺在 inbox -------------------------------------------------------
  L.push(`## 还躺在 inbox：${s.inbox.length} 张`)
  L.push('')
  if (s.inbox.length === 0) {
    L.push('(没有。每一张都有你自己的话 —— 这是这个项目唯一真正的成就指标。)')
    L.push('')
  } else {
    const stale = s.inbox.filter(i => i.ageDays > STALE_DAYS)
    if (stale.length > 0) {
      L.push(`其中 **${stale.length} 张躺了 ${STALE_DAYS} 天以上**。`)
      L.push('躺久了不是「以后再说」，是**你自己当时也没想清楚** —— 那正是该重看一遍的：')
      L.push('')
    }
    for (const { card: c, ageDays } of s.inbox.slice(0, 12)) {
      const flag = ageDays > STALE_DAYS ? `  ⏳ ${ageDays} 天` : ''
      L.push(`- ${c.title}  \`${c.id}\`${flag}`)
    }
    if (s.inbox.length > 12) L.push(`- …… 还有 ${s.inbox.length - 12} 张（\`coach kb --stale\`）`)
    L.push('')
    L.push('要认下一张：`coach save --id <id> --stdin <<\'EOF\'` 然后写你自己的话。')
    L.push('')
  }

  // ---- 可以固化进项目的 ---------------------------------------------------
  L.push(`## 可以固化进项目的规则：${s.rules.length} 条`)
  L.push('')
  if (s.rules.length === 0) {
    L.push('(没有。规则是**认领之后的副产品**，不是要凑的指标 —— 空着很正常。)')
    L.push('')
  } else {
    const grouped = new Map<string, Rule[]>()
    for (const r of s.rules) grouped.set(r.cwd, [...(grouped.get(r.cwd) ?? []), r])
    for (const [cwd, list] of grouped) {
      L.push(`**${cwd === '' ? '(卡片里没记项目目录)' : cwd}**`)
      for (const r of list) L.push(`- ${r.line}${r.sessions >= 2 ? `  （${r.sessions} 场会话）` : ''}`)
      L.push('')
      if (cwd !== '') {
        L.push('```')
        L.push(`coach rule apply --cwd ${cwd} --check    # 预演`)
        L.push(`coach rule apply --cwd ${cwd} --yes      # 真写进那个项目的 CLAUDE.md / AGENTS.md`)
        L.push('```')
        L.push('')
      }
    }
  }

  // ---- 花费 ---------------------------------------------------------------
  L.push('## 本周花费')
  L.push('')
  L.push(`**$${s.spend.total.toFixed(4)}**`)
  L.push('')
  if (s.spend.byDate.length === 0) {
    L.push('(这周没有调用过模型 —— 这一节是 0 不是缺数据。')
    L.push('默认的 `--brain none` 就是一次都不调。)')
  } else {
    for (const [d, v] of s.spend.byDate) L.push(`- ${d}  $${v.toFixed(4)}`)
    L.push('')
    L.push('记账是估算值，以端点账单为准。逐日流水只保留 60 天。')
  }
  L.push('')

  L.push('---')
  L.push('')
  L.push('这份报告是 `coach digest` 算出来的，**没有调用任何模型** ——')
  L.push('它只是把知识库里已经有的东西按周摆好。')
  return L.join('\n')
}

function firstLine(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length <= 120 ? flat : flat.slice(0, 119) + '…'
}
