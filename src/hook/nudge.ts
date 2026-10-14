#!/usr/bin/env node
// 卡点即时提醒 —— 挂在 UserPromptSubmit 上的热路径。
//
// ★ 硬约束(计划里写死的):**必须 <100ms;超时/异常一律静默退出 0;LLM 永不在这里跑。**
//   这个进程在**每一次回车**之前跑,它慢 100ms,用户就永远感觉得到。
//
// ★ 这个文件**不许有顶层副作用** —— 入口在 `entry.ts`。曾经这里就是入口,
//   底部直接 `runHook()`,结果是:任何 `import` 它的测试都会真的跑一遍 hook,
//   而 `readStdin()` 里的 `readFileSync(0)` 在没有 stdin 的进程里**永远阻塞**,
//   于是 `bun test` 直接挂死。逻辑与入口分开,是为了让"能不能测"不依赖于
//   "它会不会在读标准输入时挂住"。
//
// 顺序是刻意排的 —— 越便宜越靠前,绝大多数 prompt 在前三步就退出了:
//
//   1. 哨兵:我们自己 `claude -p` 调起的会话不该再触发我们自己(递归)
//   2. 不是 Claude Code 在叫我们(没 stdin / 没 transcript / 事件名不对)→ 退出
//   3. 开关 + 冷却 + 每日上限:读一次小 JSON 就能决定闭嘴。**在读会话之前。**
//   4. 只有到这一步才去读 transcript 的尾部
//   5. 算得出提醒才写 stdout
//
// 为什么第 3 步要在第 4 步之前:绝大多数回车都该是"闭嘴",而读 transcript
// 是这里唯一有一点分量的 IO。把闸门放前面,常态路径就只剩一次 config+state 读。
//
// 输出走**纯文本 stdout + exit 0**。这不是随便挑的:UserPromptSubmit 上纯文本
// stdout 会被原样注入上下文(前缀是 hook 名),而 JSON 信封只有"整个 stdout 恰好
// 是一个 JSON 对象"时才会被解析 —— 一旦我们打印的 JSON 坏掉(转义、多一个字符),
// 它既不算上下文也不算报错,提醒就凭空消失了。一行纯文本没有这个失败模式。

import { readFileSync, writeSync } from 'node:fs'
import { parseClaudeSession } from '../adapters/claude-code/parse.ts'
import { insideBrainCall } from '../brain/types.ts'
import { loadConfig, type CoachConfig } from '../core/config.ts'
import { GATED_TOOLS } from '../core/heuristics.ts'
import type { Session } from '../core/model.ts'
import { resolveKb } from '../core/paths.ts'
import { loadRecall, matchRecall } from '../core/recall.ts'
import { nudgeFor } from '../core/signals.ts'
import { loadState, saveState, today, type CoachStateFile } from '../core/state.ts'

/** 只在 UserPromptSubmit 上工作。被误挂到别的事件上时安静退出。 */
const EVENT = 'UserPromptSubmit'

interface HookInput {
  session_id?: string
  transcript_path?: string
  cwd?: string
  prompt?: string
  hook_event_name?: string
}

/**
 * 读 stdin。
 *
 * `isTTY` 那道判断是必须的:没人 pipe 东西进来时 `readFileSync(0)` 会**一直等**,
 * 而 hook 卡住 = 每次回车都卡住。宁可什么都不做。
 */
function readStdin(): string {
  if (process.stdin.isTTY === true) return ''
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// 下面几个是纯函数,单独拆出来是为了能测 —— 热路径的正确性不该只能靠手敲
// ---------------------------------------------------------------------------

export interface TailFacts {
  /** 报错签名 → 尾部窗口里出现几次。 */
  errorCounts: Map<string, number>
  /** 尾部窗口里有没有动过文件。 */
  touchedFiles: boolean
}

/** 从尾部解析结果里抠出 nudgeFor 要的那几个事实。 */
export function tailFacts(session: Session): TailFacts {
  const errorCounts = new Map<string, number>()
  let touchedFiles = false
  for (const turn of session.turns) {
    for (const call of turn.toolCalls) {
      if ((GATED_TOOLS as readonly string[]).includes(call.name)) touchedFiles = true
      const result = call.result
      if (result === null || result.ok !== false) continue
      const sig = result.errorSig
      if (sig === undefined || sig === '') continue
      errorCounts.set(sig, (errorCounts.get(sig) ?? 0) + 1)
    }
  }
  return { errorCounts, touchedFiles }
}

/** 冷却与每日上限。返回 false 就该在读会话**之前**退出。 */
export function allowedNow(state: CoachStateFile, cfg: CoachConfig, nowMs: number): boolean {
  const h = state.hook
  // 日子变了,计数重来 —— 不重来的话昨天用满 6 次,今天一次都不提醒。
  if (h.firedDate !== today(new Date(nowMs))) return true
  if (h.firedToday >= cfg.hook.maxPerDay) return false
  if (h.lastFiredAt === undefined) return true
  const last = Date.parse(h.lastFiredAt)
  if (Number.isNaN(last)) return true
  return nowMs - last >= cfg.hook.minGapSeconds * 1000
}

/** 冷却窗口内已经提醒过的 key。既去重、又给了"同一个坑别反复念"的时间窗。 */
export function firedRecently(
  state: CoachStateFile,
  cfg: CoachConfig,
  nowMs: number,
): Set<string> {
  const out = new Set<string>()
  const cutoff = nowMs / 1000 - cfg.hook.cooldownSeconds
  for (const [key, ts] of Object.entries(state.hook.firedKeys)) {
    if (typeof ts === 'number' && ts >= cutoff) out.add(key)
  }
  return out
}

/** 记一笔。只在实际说了话之后调用。 */
export function remember(
  state: CoachStateFile,
  key: string,
  nowMs: number,
  cfg: CoachConfig,
): void {
  const d = today(new Date(nowMs))
  const h = state.hook
  h.firedToday = h.firedDate === d ? h.firedToday + 1 : 1
  h.firedDate = d
  h.lastFiredAt = new Date(nowMs).toISOString()
  h.firedKeys[key] = Math.floor(nowMs / 1000)

  // 顺手清掉过期的 key —— 不清的话这个表只增不减,而 state.json 每次都被
  // 整个读写,它会慢慢变成热路径上最贵的那一项。
  const cutoff = nowMs / 1000 - cfg.hook.cooldownSeconds * 2
  for (const [k, ts] of Object.entries(h.firedKeys)) {
    if (typeof ts === 'number' && ts < cutoff) delete h.firedKeys[k]
  }
}

// ---------------------------------------------------------------------------

export async function runHook(): Promise<void> {
  // ① 哨兵,必须是第一件事。`claude -p` 是我们自己起的,它若再触发我们,
  //    就是无限递归 —— 而递归的代价是钱。
  if (insideBrainCall()) return

  const raw = readStdin()
  if (raw.trim() === '') return

  let input: HookInput
  try {
    input = JSON.parse(raw) as HookInput
  } catch {
    return
  }

  // ② 事件名不对就不说话。挂在别的事件上时(比如 Stop)我们的输出语义不同,
  //    这里挡掉比让它在错误的位置上输出更安全。
  if (input.hook_event_name !== undefined && input.hook_event_name !== EVENT) return

  const transcript = input.transcript_path
  if (transcript === undefined || transcript === '') return

  const kb = resolveKb()
  const cfg = loadConfig(kb)
  if (!cfg.hook.enabled) return

  const started = Date.now()
  const state = loadState(kb)
  if (!allowedNow(state, cfg, started)) return

  // ③ 到这一步才读会话尾巴。
  const session = await parseClaudeSession(transcript, { tailBytes: cfg.hook.tailBytes })
  const { errorCounts, touchedFiles } = tailFacts(session)

  const prompt = input.prompt ?? ''
  const alreadyNudged = firedRecently(state, cfg, started)
  // 旧卡检索表是 writeIndex 预先压好的一份小 JSON，这里只读它，不扫卡片目录。
  const recall = cfg.hook.recall ? matchRecall(prompt, loadRecall(kb), alreadyNudged) : null

  const nudge = nudgeFor({ errorCounts, prompt, touchedFiles, alreadyNudged, recall })
  if (nudge === null) return

  // ④ 超预算宁可不说。一句迟到的提醒没有价值,而它已经花掉了用户的等待。
  //    实测常态在 ~60ms 以内(见 docs/design.md 里那张表),所以正常情况
  //    走不到这一行;它挡的是"这台机器当时正忙"。
  if (Date.now() - started > budgetMs()) return

  writeSync(1, nudge.text + '\n')
  remember(state, nudge.key, started, cfg)
  try {
    saveState(kb, state)
  } catch {
    /* 记账失败不该影响已经说出去的话 */
  }
}

/** 硬预算。留了环境变量是为了能把测试钉在确定的行为上。 */
export function budgetMs(): number {
  const raw = Number(process.env['COACH_HOOK_BUDGET_MS'])
  return Number.isFinite(raw) && raw > 0 ? raw : 80
}

