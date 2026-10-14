// 命令之间共用的那点东西:知识库在哪、用哪个脑、这次处理哪个会话。
//
// 抽出来不是为了少写几行,是为了一条规则能被所有命令一致地执行:
// **脑没被显式打开过,就当它是 none**。如果每个命令各写一遍这个判断,
// 迟早有一个会写漏,然后那个命令会悄悄把会话发出去。

import { parseClaudeSession } from '../adapters/claude-code/parse.ts'
import type { Args } from '../args.ts'
import { isBrainName } from '../brain/index.ts'
import type { Candidate } from '../brain/types.ts'
import { excerptTurns, sessionHeader } from '../core/excerpt.ts'
import type { Session } from '../core/model.ts'
import { ensureKb, resolveKb, type KbPaths } from '../core/paths.ts'
import { findClaudeSessions, resolveSession, type FoundSession } from '../core/sessions.ts'
import { loadState, type CoachStateFile } from '../core/state.ts'

export interface Ctx {
  kb: string
  paths: KbPaths
  state: CoachStateFile
  args: Args
  out: (s: string) => void
  err: (s: string) => void
}

export function makeCtx(args: Args): Ctx {
  const kb = resolveKb(args.get('kb') ?? process.env['COACH_KB'])
  return {
    kb,
    paths: ensureKb(kb),
    state: loadState(kb),
    args,
    out: (s: string) => process.stdout.write(s + '\n'),
    err: (s: string) => process.stderr.write(s + '\n'),
  }
}

/**
 * 这次用哪个脑。
 *
 * 优先级:`--brain` > `--llm`(旧写法) > state 里存的 > none。
 * **state 里的 `enabled` 是硬闸门** —— 就算 config 里写着 `claude`,
 * 只要没 `coach brain enable --yes` 过,这里也返回 none。
 * 装完就默认外发是最坏的一种默认。
 */
export function resolveBrainName(ctx: Ctx): { name: string; why: string } {
  const explicit = ctx.args.get('brain')
  if (explicit !== undefined) {
    if (!isBrainName(explicit)) return { name: 'none', why: `--brain ${explicit} 不认识,退到 none` }
    return { name: explicit, why: '--brain 指定' }
  }
  // `--llm` / `--no-llm`:老写法,语义是「要不要调模型」,具体哪个脑看 state
  if (ctx.args.given('llm')) {
    if (!ctx.args.bool('llm')) return { name: 'none', why: '--no-llm' }
    const chosen = ctx.state.brain.chosen === 'none' ? 'claude' : ctx.state.brain.chosen
    return { name: chosen, why: `--llm(用 ${chosen})` }
  }
  if (!ctx.state.brain.enabled || ctx.state.brain.chosen === 'none') {
    return { name: 'none', why: '脑未启用(要调模型先跑 coach brain enable --yes)' }
  }
  return { name: ctx.state.brain.chosen, why: 'state 里配置的' }
}

/** 今天还剩多少额度。 */
export function remainingBudget(ctx: Ctx): number | undefined {
  const st = ctx.state
  if (st.digest.spentDate !== todayStr()) return st.brain.maxUsdPerDay
  return Math.max(0, st.brain.maxUsdPerDay - st.digest.spentTodayUsd)
}

function todayStr(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export interface SessionPick {
  found: FoundSession | null
  how: string
  session?: Session
}

/**
 * 会话来自哪个宿主。`--host` 显式给优先;否则看 `--session` 给的路径像谁;
 * 都没有就是 claude-code(向后兼容:旧的 skill 与命令都不带 --host)。
 */
export function hostOf(ctx: Ctx): 'claude-code' | 'codex' | null {
  const h = ctx.args.get('host')
  if (h === 'codex') return 'codex'
  if (h === 'claude-code' || h === 'claude') return 'claude-code'
  if (h !== undefined) return null
  const s = ctx.args.get('session')
  if (s !== undefined && /(^|\/)rollout-[^/]*\.jsonl$/.test(s)) return 'codex'
  return 'claude-code'
}

export async function loadSession(ctx: Ctx): Promise<SessionPick> {
  const flag = ctx.args.get('session') ?? (ctx.args.bool('latest') ? 'latest' : 'latest')
  const host = hostOf(ctx)
  if (host === null) {
    return { found: null, how: `--host 只认 claude-code / codex(WorkBuddy 没有可读的会话,见 docs/integration.md)` }
  }

  if (host === 'codex') {
    const { findCodexSessions, readCodexCwd } = await import('../adapters/codex/sessions.ts')
    const { parseCodexSession } = await import('../adapters/codex/parse.ts')
    const { session: found, how } = resolveSession(flag, { sessions: findCodexSessions(), readCwd: readCodexCwd })
    if (found === null) return { found: null, how }
    const parsed = await parseCodexSession(found.path)
    parsed.cwd = parsed.cwd === '' ? found.cwd : parsed.cwd
    return { found, how, session: parsed }
  }

  const { session: found, how } = resolveSession(flag, { sessions: findClaudeSessions() })
  if (found === null) return { found: null, how }

  const parsed = await parseClaudeSession(found.path)
  parsed.cwd = parsed.cwd === '' ? found.cwd : parsed.cwd
  return { found, how, session: parsed }
}

// ---------------------------------------------------------------------------
// 证据摘要
// ---------------------------------------------------------------------------

/**
 * 给一批候选拼出上下文。
 *
 * 不是「把整场会话塞进去」,而是**每条候选各取窗口再拼起来** ——
 * 一次 50MB 的会话里,信号往往挤在少数几段里,而模型需要的恰恰是那几段
 * 前后的因果。按预算均分给每条候选,比按时间轴从头截更省也更准。
 *
 * 证据行(tier 0)永远优先 —— 那是卡片的立身之本,穷到只剩 200 token 也得留住。
 */
export function buildExcerpt(session: Session, candidates: Candidate[], budget = 6000): { text: string; tokens: number; truncated: boolean } {
  if (candidates.length === 0) return { text: '', tokens: 0, truncated: false }
  // 每条候选的窗口给预算的一半均分(另一半留给 header 与轮间叙述),
  // 但不得低于 400 —— 低于 400 连一条证据行都放不下,窗口就没意义了。
  const per = Math.max(400, Math.floor((budget * 0.5) / candidates.length))

  const seen = new Set<number>()
  const parts: string[] = []
  let tokens = 0
  let truncated = false

  for (const cand of candidates) {
    const center = cand.turnIndex ?? 0
    // 同一个中心点只取一次:两条候选落在同一轮时,重复贴窗口纯属浪费预算
    if (seen.has(center)) continue
    seen.add(center)
    const ex = excerptTurns(session.turns, center, { budget: per })
    if (ex.text.trim() === '') continue
    parts.push(`── [候选 ${cand.index}] 第 ${center} 轮附近 ──\n${ex.text}`)
    tokens += ex.tokens
    if (ex.truncated) truncated = true
    if (tokens >= budget) break
  }

  return { text: parts.join('\n\n'), tokens, truncated }
}

export function headerFor(session: Session): string {
  return sessionHeader(session)
}
