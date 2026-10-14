// 阶段机 —— 从旧 coach 的 `advance()` 移植。
//
// 出处：~/.claude/dev-mods/91878ba0-b090-4f9d-a0d8-3a36ebeb059d/coach/hooks/logic.ts
//
// 它靠**用户消息的位置**推进（第 1 句是任务、第 2 句是判断、第 3 句是「开始」），
// 不靠语义猜测 —— 零幻觉面，而且 Codex / WorkBuddy 上同样成立。
//
// 沉淀层用到它，是为了回答「这一轮里用户到底说没说出过自己的判断」——
// 说出来了，那句话就是卡片「我自己的表述」一节最理想的素材。

import type { CoachLevel, CoachPhase } from './heuristics.ts'
import { clip, isSkip, worthCoaching } from './heuristics.ts'

export interface CoachTask {
  id: number
  phase: CoachPhase
  /** 任务的开头（截断），用来认出「同一件事」。 */
  promptHead: string
  /** ★ 用户说出的判断，**逐字**。整个沉淀层最不可替代的一行。 */
  prediction: string
  denies: number
  isSkipped: boolean
}

export interface CoachStats {
  tasks: number
  skips: number
  consecutiveSkips: number
}

export interface CoachState {
  level: CoachLevel
  task: CoachTask | null
  stats: CoachStats
}

export const DEFAULT_STATS: CoachStats = { tasks: 0, skips: 0, consecutiveSkips: 0 }

export const DEFAULT_STATE: CoachState = { level: 'lite', task: null, stats: DEFAULT_STATS }

export interface Advance {
  state: CoachState
  /** 这一轮该给模型的阶段提示；'' 表示什么都不加。 */
  line: string
  /** 用户连着跳过到自动关闭了。 */
  gagged: boolean
}

export const SKIP_LINE =
  '[coach] 用户要求跳过:立刻动手,不要再问,也不要解释教练模式。'

export const PHASE_LABEL: Record<CoachPhase, string> = {
  idle: '',
  ask: 'A 等你说做法',
  contrast: 'B 对照中',
  execute: 'C 执行中',
}

export function phaseLine(phase: CoachPhase, prediction: string): string {
  switch (phase) {
    case 'ask':
      return [
        '[coach] 阶段 A:等用户说做法。不要写文件、不要改文件。',
        '现在就问一句「你打算先从哪里入手?」然后停下等他回答。',
        '若这是琐碎任务(改错别字、格式化、跑一条命令、解释代码),直接做,不要问。',
      ].join('\n')
    case 'contrast':
      return [
        '[coach] 阶段 B:对照。用户刚才的判断原文:「' + clip(prediction, 300) + '」',
        '按 1 你说对的 / 2 你漏掉的 / 3 我做法不同的 三段回答,总共不超过 6 行,',
        '然后问「可以开始了吗?」。不要写文件。',
      ].join('\n')
    case 'execute':
      return [
        '[coach] 阶段 C:执行。用户已同意,直接干活,不要每步请示。',
        '全部做完后用四行复盘收尾:做了什么 / 为什么这么做 /',
        '和你的判断差在哪 / 下次这类问题你可以先看什么。',
      ].join('\n')
    default:
      return ''
  }
}

function newTask(stats: CoachStats, text: string): CoachTask {
  return {
    id: stats.tasks + 1,
    phase: 'ask',
    promptHead: clip(text, 200),
    prediction: '',
    denies: 0,
    isSkipped: false,
  }
}

/**
 * 把一条用户消息喂进阶段机，回答新状态与该说的话。
 *
 * `quiet` 是「上一轮一个工具都没调」—— 那一轮只是聊天，所以此时来的一个
 * 非平凡请求意味着上一件事已经翻篇，可以开新一轮。没有这个信号，同一个
 * 任务里的每一句追问都会重新反问一次。
 */
export function advance(state: CoachState, raw: string, quiet: boolean): Advance {
  const text = raw.trim()

  if (isSkip(text, state.task?.phase ?? null)) {
    const wasCoaching = state.task !== null && state.task.phase !== 'idle'
    const consecutive = wasCoaching ? state.stats.consecutiveSkips + 1 : 0
    const gagged = consecutive >= 2
    return {
      state: {
        level: gagged ? 'off' : state.level,
        task:
          state.task === null ? null : { ...state.task, phase: 'execute', isSkipped: true },
        stats: {
          ...state.stats,
          skips: wasCoaching ? state.stats.skips + 1 : state.stats.skips,
          consecutiveSkips: consecutive,
        },
      },
      line: wasCoaching ? SKIP_LINE : '',
      gagged,
    }
  }

  const t = state.task

  if (t === null || t.phase === 'idle' || (t.phase === 'execute' && quiet)) {
    if (!worthCoaching(text)) return { state, line: '', gagged: false }
    return {
      state: {
        ...state,
        task: newTask(state.stats, text),
        stats: { ...state.stats, tasks: state.stats.tasks + 1, consecutiveSkips: 0 },
      },
      line: phaseLine('ask', ''),
      gagged: false,
    }
  }

  if (t.phase === 'ask') {
    // ★ 这句话就是用户的判断 —— 逐字存。不改写、不摘要。
    return {
      state: { ...state, task: { ...t, phase: 'contrast', prediction: text } },
      line: phaseLine('contrast', text),
      gagged: false,
    }
  }

  if (t.phase === 'contrast') {
    return {
      state: { ...state, task: { ...t, phase: 'execute' } },
      line: phaseLine('execute', t.prediction),
      gagged: false,
    }
  }

  return { state, line: phaseLine(t.phase, t.prediction), gagged: false }
}

/**
 * 从一条会话里把「用户说过的判断」全部捞出来。
 *
 * 这就是沉淀层和提问层的接口：提问层负责让用户**开口**，这里负责把那些
 * 开口的瞬间从日志里捡回来（旧实现的问题在于它只顾着问，捡的那一步
 * 挂在 `DEBRIEF_RE.test(模型输出)` 上，于是什么也没捡到）。
 */
export function predictionsFrom(
  turns: Array<{ role: string; text: string; toolCalls: unknown[] }>,
): string[] {
  const out: string[] = []
  let state = DEFAULT_STATE
  let prevHadTools = false

  for (const turn of turns) {
    if (turn.role === 'human') {
      const before = state.task?.prediction ?? ''
      state = advance(state, turn.text, !prevHadTools).state
      const after = state.task?.prediction ?? ''
      if (after !== before && after !== '') out.push(after)
    }
    prevHadTools = turn.toolCalls.length > 0
  }
  return out
}
