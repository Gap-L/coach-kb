// 脑子注册表 + 选谁 + 失败了怎么办。
//
// 默认是 `none`（**不调 LLM**）。这不是保守，是立场：
//
//   知识库里装的是你工作时的一切 —— 代码、报错、路径、项目名。把这些发到
//   一个自定义端点上，是一件必须由你**明确点头**的事，不能是「装完就默认发生」。
//   旧 coach 的问题之一是它从不落盘；反方向的错误（悄悄把会话发出去）更糟。
//
//   所以 `brain none` 是默认，`coach brain enable --yes` 才切走。
//
// 另一条：**任何脑子失败都不许静默**。降级时会带一句 `degraded`，它一路走到
// 命令输出里。可以退化，不可以让人以为「AI 看过了」而其实没有。

import { claudeBrain } from './claude.ts'
import { codexBrain } from './codex.ts'
import { httpBrain } from './http.ts'
import { noneBrain } from './none.ts'
import type { Brain, BrainOptions, BrainResult, DistillInput } from './types.ts'

export const BRAINS: Record<string, Brain> = {
  none: noneBrain,
  claude: claudeBrain,
  codex: codexBrain,
  http: httpBrain,
}

export const BRAIN_NAMES = ['none', 'claude', 'codex', 'http'] as const

export function isBrainName(s: string): boolean {
  return Object.hasOwn(BRAINS, s)
}

export function getBrain(name: string): Brain {
  return BRAINS[name] ?? noneBrain
}

export interface FallbackOptions extends BrainOptions {
  /** 名字。'none' 或未知名字一律走 none。 */
  brain: string
  /** 脑不可用时退到哪个。默认 'none'。 */
  fallback?: string
}

/**
 * 跑一次蒸馏，带降级。
 *
 * 降级链是 `chosen → fallback('none')`，只有一跳 —— 不要「claude 挂了试 codex
 * 再试 http」那种链：那会在端点出故障时反复重试、反复把会话发出去，
 * 而每一次都可能是几十秒的等待。失败一次就够了，产出骨架卡。
 */
export async function distillWithFallback(input: DistillInput, opts: FallbackOptions): Promise<BrainResult> {
  const chosen = opts.brain
  const brain = getBrain(chosen)

  if (brain.name === 'none') {
    return noneBrain.distill(input, opts)
  }

  // 预算闸门：今天的钱花完就不再调，直接骨架卡。
  if (opts.budgetUsd !== undefined && opts.budgetUsd <= 0) {
    const r = await noneBrain.distill(input, opts)
    return { ...r, degraded: `今天的额度已用完(上限见 coach brain status),这次不调模型` }
  }

  let result: BrainResult
  try {
    result = await brain.distill(input, opts)
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    const r = await noneBrain.distill(input, opts)
    return { ...r, brain: chosen, degraded: `${chosen} 抛异常(${why}),已降级为骨架卡` }
  }

  if (result.drafts.length > 0) return result

  // 一条都没补上 = 这次等于没调。退到 fallback 的产出，但保留原脑的名字与原因，
  // 好让人看得出「是 claude 失败了」而不是「本来就是 none」。
  const fallback = await getBrain(opts.fallback ?? 'none').distill(input, opts)
  return {
    ...fallback,
    brain: chosen,
    degraded: result.degraded ?? `${chosen} 没有产出任何可用条目`,
  }
}
