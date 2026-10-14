// `coach distill` —— 把一场会话压成若干张**半成品卡**落进知识库。
//
// 这是沉淀层的主干,其余命令都是围着它转。它做四件事,顺序不能换:
//
//   1. 会话 → 信号    (确定性:正则 + 计数,不看模型脸色)
//   2. 信号 → 候选    (确定性:标题/类型/证据从会话里抠出来)
//   3. 候选 → 草稿    (★ 唯一不确定的一步,可以整个跳过)
//   4. 草稿 → 卡片    (确定性:写盘前再扫一遍密钥)
//
// 第 3 步失败**不影响前两步的成果** —— 这正是旧 coach 的反面:它把
// 「有没有记录」寄托在模型有没有写出那句话上,于是 notes 永远是 0。

import { distillWithFallback } from '../brain/index.ts'
import { toCandidates } from '../core/candidates.ts'
import { writeIndex } from '../core/kb.ts'
import { detect } from '../core/signals.ts'
import { saveState, shiftDays, today } from '../core/state.ts'
import { type Ctx, buildExcerpt, headerFor, loadSession, remainingBudget, resolveBrainName } from './ctx.ts'
import { reportLines, sinkCards, type Written } from './sink.ts'

export async function runDistill(ctx: Ctx): Promise<number> {
  const { args, out, err } = ctx
  const dryRun = args.bool('dry-run')
  const force = args.bool('force')
  const limit = args.num('limit', 40)

  const pick = await loadSession(ctx)
  if (pick.found === null || pick.session === undefined) {
    err(`✗ ${pick.how}`)
    return 1
  }
  const { found, session } = pick

  // ---- 幂等闸门 -----------------------------------------------------------
  // 只有「文件一模一样」才跳过。会话还在长(大小/时间戳变了)就照常处理 ——
  // 那不是重复劳动:id 是确定性的,upsert 会把结果收敛到同一张卡上。
  const cursor = ctx.state.sessions[found.path]
  if (!force && cursor !== undefined && cursor.size === found.size && cursor.mtimeMs === found.mtimeMs) {
    out(`已处理过:${found.sessionId.slice(0, 8)}(--force 可重跑)`)
    return 0
  }

  const { signals, scanned } = detect(session)
  const candidates = toCandidates(signals, { limit })

  if (candidates.length === 0) {
    out(`这场会话没有值得沉淀的卡点(扫了 ${Object.keys(scanned).length} 类规则,信号 0 条)`)
    if (!dryRun) {
      markProcessed(ctx, found.path, found.size, found.mtimeMs, [])
      saveState(ctx.kb, ctx.state)
    }
    return 0
  }

  // ---- 补「为什么」 -------------------------------------------------------
  const { name: brainName, why } = resolveBrainName(ctx)
  const budget = remainingBudget(ctx)
  const excerpt = buildExcerpt(session, candidates)

  // 把「这次挑的是哪一场、凭什么是它」打出来。挑错了要能一眼看见 ——
  // 静默挑错会话是这个命令最难查的一类故障（输出看着完全正常）。
  out(`会话 ${found.sessionId.slice(0, 8)}  ${pick.how}`)
  out(`目录 ${session.cwd === '' ? '(未知)' : session.cwd}`)
  out(`候选 ${candidates.length} 条(扫出 ${signals.length} 条信号)  脑 ${brainName}(${why})`)

  const result = await distillWithFallback(
    { header: headerFor(session), excerpt: excerpt.text, candidates },
    {
      brain: brainName,
      // ★ cwd 指向知识库而非项目目录:项目里若有 CLAUDE.md / memory,
      //   会被 headless 会话当上下文加载,白白计入每次调用的固定开销。
      cwd: ctx.kb,
      timeoutMs: args.num('timeout', 120_000),
      ...(args.get('model') === undefined ? {} : { model: args.get('model') as string }),
      ...(budget === undefined ? {} : { budgetUsd: budget }),
    },
  )

  if (result.degraded !== undefined) {
    // 降级不是错误,但**必须显眼** —— 否则用户会以为 AI 看过了。
    err(`⚠ ${result.degraded}`)
  }
  if (result.usage !== undefined) {
    out(`用量 input ${result.usage.inputTokens} / output ${result.usage.outputTokens}  $${result.usage.costUsd.toFixed(4)}  ${result.usage.ms}ms`)
  }

  const { written, refused } = sinkCards(ctx.kb, session, candidates, result.drafts, { dryRun })

  if (!dryRun) {
    markProcessed(ctx, found.path, found.size, found.mtimeMs, written.filter(w => w.created).map(w => w.id))
    chargeUsage(ctx, result.usage?.costUsd ?? 0)
    saveState(ctx.kb, ctx.state)
    const { total, confirmed } = writeIndex(ctx.kb)
    out(`知识库共 ${total} 张卡(已确认 ${confirmed} / 待认领 ${total - confirmed})`)
  }

  report(ctx, written, refused, dryRun)
  return refused.length > 0 ? 1 : 0
}

// ---------------------------------------------------------------------------

export function report(ctx: Ctx, written: Written[], refused: string[], dryRun: boolean): void {
  const { out, err } = ctx
  for (const w of written) out(reportLines(w))
  for (const r of refused) err(`  ✗ ${r}`)

  const created = written.filter(w => w.created).length
  const updated = written.filter(w => !w.created && w.changed).length
  const unchanged = written.length - created - updated
  out(
    `${dryRun ? '[dry-run] ' : ''}新建 ${created} / 更新 ${updated} / 未变 ${unchanged}` +
      (refused.length === 0 ? '' : ` / 拒绝 ${refused.length}`),
  )
  if (created + updated > 0 && !dryRun) {
    out('下一步:用你自己的话把它们认下来 —— coach kb --list 看待补的,再 coach save --id <id> --my-words "…"')
  }
}

export function markProcessed(ctx: Ctx, path: string, size: number, mtimeMs: number, cardIds: string[]): void {
  ctx.state.sessions[path] = {
    path,
    size,
    mtimeMs,
    lines: 0,
    lastProcessedAt: new Date().toISOString(),
    cardsEmitted: cardIds,
  }
  const t = today()
  ctx.state.counters.byDate[t] = (ctx.state.counters.byDate[t] ?? 0) + cardIds.length
}

/** 记账。跨天时归零再累加 —— 否则昨天的花费会一直压着今天的额度。 */
export function chargeUsage(ctx: Ctx, costUsd: number): void {
  if (costUsd <= 0) return
  const t = today()
  if (ctx.state.digest.spentDate !== t) {
    ctx.state.digest.spentDate = t
    ctx.state.digest.spentTodayUsd = 0
  }
  ctx.state.digest.spentTodayUsd += costUsd
  ctx.state.digest.spendByDate[t] = (ctx.state.digest.spendByDate[t] ?? 0) + costUsd
  pruneSpend(ctx.state.digest.spendByDate, t)
}

/**
 * 流水只留 60 天。
 *
 * state 是**每次整份覆盖写**的，所以一个无限长的流水表意味着每次 distill
 * 都要多写一遍全部历史。60 天够周报用；更早的逐日金额没有读者。
 * 按日期字符串排序删最省事 —— 这个格式的字典序就是时间序。
 */
function pruneSpend(ledger: Record<string, number>, todayStr: string): void {
  const cutoff = shiftDays(todayStr, -60)
  for (const k of Object.keys(ledger)) {
    if (k < cutoff) delete ledger[k]
  }
}
