// `coach review` —— 把一场会话的卡点摊在你面前,**默认一个字都不落盘**。
//
// 这是整个项目里唯一一个"提问"的命令,而它只问一句:
//
//     这几条里,哪条是你真觉得自己学到东西的?
//
// 为什么要把「找出候选」和「认下候选」分成两步:因为本项目成败的唯一指标
// 是**你自己写的那句话有没有出现**。如果 review 顺手就把卡落了,
// 知识库会迅速被 AI 摘要灌满,而摘要不会让人变强 —— 那正是旧 coach 的失败
// 换了个形式重演(它连落盘都没有,我们则是落了一堆不是你的东西)。
//
// 所以:review 看,distill 落骨架,save 认领。三个动词,三种意图,不合并。

import { distillWithFallback } from '../brain/index.ts'
import { toCandidates } from '../core/candidates.ts'
import { writeIndex } from '../core/kb.ts'
import { detect } from '../core/signals.ts'
import { saveState } from '../core/state.ts'
import { buildExcerpt, headerFor, loadSession, remainingBudget, resolveBrainName, type Ctx } from './ctx.ts'
import { chargeUsage, markProcessed, report } from './distill.ts'
import { sinkCards } from './sink.ts'

export async function runReview(ctx: Ctx): Promise<number> {
  const { args, out, err } = ctx

  const pick = await loadSession(ctx)
  if (pick.found === null || pick.session === undefined) {
    err(`✗ ${pick.how}`)
    return 1
  }
  const { found, session } = pick

  const { signals, scanned } = detect(session)
  const candidates = toCandidates(signals, { limit: args.num('limit', 20) })

  if (args.bool('json')) {
    out(
      JSON.stringify(
        {
          session: { id: session.sessionId, path: found.path, cwd: session.cwd, turns: session.turns.length },
          scanned,
          signalCount: signals.length,
          candidates,
        },
        null,
        2,
      ),
    )
    return 0
  }

  if (candidates.length === 0) {
    out(`这场会话没有值得沉淀的卡点(扫了 ${Object.keys(scanned).length} 类规则,信号 ${signals.length} 条)`)
    return 0
  }

  out(`会话 ${found.sessionId.slice(0, 8)}  ${pick.how}`)
  out(`目录 ${session.cwd === '' ? '(未知)' : session.cwd}  ${session.turns.length} 回合`)
  out(`挑出 ${candidates.length} 个卡点(扫出 ${signals.length} 条信号)。**这些还都不是知识,只是候选。**`)
  out('')

  for (const c of candidates) {
    out(`[${c.index}] ${c.title}`)
    out(`     类型 ${c.type}   第 ${c.turnIndex ?? 0} 轮`)
    out(`     为什么挑中它:${c.why}`)
    if (c.evidence.length > 0) {
      out('     证据(直接来自会话,不是我编的):')
      for (const e of c.evidence.slice(0, 5)) out(`       · ${e}`)
      if (c.evidence.length > 5) out(`       · …另有 ${c.evidence.length - 5} 条`)
    }
    if (c.userWords !== undefined) out(`     你当时说:「${c.userWords}」`)
    out('')
  }

  if (!args.bool('save')) {
    out('─'.repeat(60))
    out('现在轮到你了 —— 挑一条,用**你自己的话**说一遍它到底意味着什么。')
    out('比如:我原来以为 X,现在知道其实是 Y,因为我看到 Z。')
    out('')
    out('  想补 AI 的解释:  coach distill --latest      (先落骨架,再逐条认领)')
    out('  直接认领某一条:  coach save --id <id> --my-words "……"')
    out('  只落骨架不调模型: coach distill --latest --no-llm')
    return 0
  }

  // ---- --save:落骨架 ------------------------------------------------------
  // 走 brain 就意味着外发。这里**不替用户决定** —— resolveBrainName 会在
  // 脑没被 enable 过时返回 none,于是默认是纯离线落骨架。
  const { name, why } = resolveBrainName(ctx)
  const budget = remainingBudget(ctx)
  out(`落盘:脑 ${name}(${why})`)
  const result = await distillWithFallback(
    { header: headerFor(session), excerpt: buildExcerpt(session, candidates).text, candidates },
    {
      brain: name,
      cwd: ctx.kb,
      timeoutMs: args.num('timeout', 120_000),
      ...(budget === undefined ? {} : { budgetUsd: budget }),
    },
  )
  if (result.degraded !== undefined) err(`⚠ ${result.degraded}`)

  const { written, refused } = sinkCards(ctx.kb, session, candidates, result.drafts)
  markProcessed(ctx, found.path, found.size, found.mtimeMs, written.filter(w => w.created).map(w => w.id))
  chargeUsage(ctx, result.usage?.costUsd ?? 0)
  saveState(ctx.kb, ctx.state)
  const { total, confirmed } = writeIndex(ctx.kb)

  report(ctx, written, refused, false)
  out(`知识库共 ${total} 张卡(已确认 ${confirmed})。刚落的这些是 status: inbox —— 补上「我自己的表述」才算数。`)
  return refused.length > 0 ? 1 : 0
}
