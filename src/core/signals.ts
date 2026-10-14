// 信号检测 —— 「哪一段会话值得变成一张卡」。
//
// **这是整个项目替代旧实现的着力点。** 旧 coach 的落盘闸门是
// `DEBRIEF_RE.test(模型的输出文本)`：只有模型逐字写出「下次…先看什么」才落盘，
// 于是 `~/.claude/coach/notes/` 至今是空的，stats 是 {tasks:0, notes:0}。
//
// 这里全部改成对**会话日志本身**做确定性判定：报错签名、编辑路径、用户消息
// 的位置与用词。模型不参与「要不要记」，只参与「为什么」。
//
// 全部是纯函数，不碰 IO —— 阈值调错了才看得见，调不动才是灾难。

import type { Evidence, Session, Signal, Turn } from './model.ts'
import { CONFUSED_RE, CORRECTION_RE, LEARNED_RE, worthCoaching } from './heuristics.ts'
import type { RecallHit } from './recall.ts'
import { predictionsFrom } from './phase.ts'

export interface SignalConfig {
  /** 同一报错签名出现几次算复现。 */
  repeatErrorMin: number
  /** 同一文件被改几次算「反复改同一处」。 */
  repeatEditMin: number
  /** 连续几次失败算「长调试」。 */
  longDebugMinFailures: number
  /** 用户纠正的消息往后看几轮，用来判断这次纠正有多要紧。 */
  correctionWindow: number
  /** 低于这个置信度的候选直接丢掉。 */
  emitMinConfidence: number
}

export const DEFAULT_SIGNAL_CONFIG: SignalConfig = {
  repeatErrorMin: 2,
  repeatEditMin: 3,
  longDebugMinFailures: 5,
  correctionWindow: 3,
  emitMinConfidence: 0.5,
}

/** 路径归一：绝对路径太长，卡片里只留仓库内相对的那一段。 */
function shortPath(path: string, cwd: string): string {
  if (cwd !== '' && path.startsWith(cwd + '/')) return path.slice(cwd.length + 1)
  const parts = path.split('/')
  return parts.length > 4 ? '…/' + parts.slice(-3).join('/') : path
}

function evidenceOf(turns: Turn[]): Evidence[] {
  const out: Evidence[] = []
  for (const t of turns) {
    for (const c of t.toolCalls) {
      if (c.result !== null) out.push(...c.result.evidence)
    }
  }
  return out
}

/** 同一段证据只留一条，避免卡片里出现五行一样的 `src/auth.ts:88`。 */
function dedupeEvidence(list: Evidence[], limit = 8): Evidence[] {
  const seen = new Set<string>()
  const out: Evidence[] = []
  for (const e of list) {
    const key = `${e.kind}:${e.text.slice(0, 120)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e)
    if (out.length >= limit) break
  }
  return out
}

export interface DetectResult {
  signals: Signal[]
  /** 诊断用：每条规则扫出多少、留下多少。调阈值时看它。 */
  scanned: Record<string, number>
}

export function detect(
  session: Session,
  config: SignalConfig = DEFAULT_SIGNAL_CONFIG,
): DetectResult {
  const signals: Signal[] = []
  // scanned 记录每条规则「扫出多少」；emitMinConfidence 之后还能剩多少，
  // 是两个不同的数 —— 调阈值时看的是后者，所以两者都报。

  const scanned: Record<string, number> = {}
  const bump = (k: string): void => {
    scanned[k] = (scanned[k] ?? 0) + 1
  }

  const turns = session.turns

  // -- 1. 同一报错复现 ------------------------------------------------------
  {
    const bySig = new Map<string, { count: number; at: number[]; head: string }>()
    turns.forEach((t, i) => {
      for (const c of t.toolCalls) {
        const sig = c.result?.errorSig
        if (sig === undefined || c.result?.ok !== false) continue
        const cur = bySig.get(sig) ?? { count: 0, at: [], head: c.result.errorHead ?? sig }
        cur.count += 1
        cur.at.push(i)
        bySig.set(sig, cur)
      }
    })
    for (const [sig, info] of bySig) {
      if (info.count < config.repeatErrorMin) continue
      bump('repeat_error')
      const at = info.at[info.at.length - 1] ?? 0
      signals.push({
        kind: 'repeat_error',
        // 撞一次是意外，撞三次是没弄懂。上限压在 0.95，给「用户亲口认证」留出位次。
        confidence: Math.min(0.95, 0.6 + 0.15 * (info.count - config.repeatErrorMin + 1)),
        turnIndex: at,
        why: `同一个报错出现了 ${info.count} 次：${sig.slice(0, 80)}`,
        evidence: dedupeEvidence(evidenceOf(turns)),
      })
    }
  }

  // -- 2. 用户纠正 AI（最值钱的一类）---------------------------------------
  {
    // 「纠正」必须紧跟在 AI 动过手之后 —— 否则只是用户在补充说明。
    turns.forEach((t, i) => {
      if (t.role !== 'human') return
      if (!CORRECTION_RE.test(t.text)) return
      const prev = turns[i - 1]
      const touched = prev !== undefined && prev.toolCalls.length > 0
      bump('user_correction')
      signals.push({
        kind: 'user_correction',
        confidence: touched ? 0.92 : 0.68,
        turnIndex: i,
        why: touched
          ? '你在 AI 动过手之后纠正了它 —— 你的判断和它的分叉点就在这'
          : '你明确否定了之前的说法',
        evidence: dedupeEvidence(evidenceOf(prev === undefined ? [] : [prev])),
        userWords: t.text,
      })
    })
  }

  // -- 3. 反复改同一处 ------------------------------------------------------
  {
    const byPath = new Map<string, { count: number; at: number[] }>()
    turns.forEach((t, i) => {
      for (const c of t.toolCalls) {
        if (c.name !== 'Edit' && c.name !== 'MultiEdit' && c.name !== 'Write') continue
        const raw = c.input['file_path'] ?? c.input['filePath']
        if (typeof raw !== 'string') continue
        const p = shortPath(raw, session.cwd)
        const cur = byPath.get(p) ?? { count: 0, at: [] }
        cur.count += 1
        cur.at.push(i)
        byPath.set(p, cur)
      }
    })
    for (const [p, info] of byPath) {
      if (info.count < config.repeatEditMin) continue
      bump('repeat_edit')
      const at = info.at[info.at.length - 1] ?? 0
      signals.push({
        kind: 'repeat_edit',
        confidence: Math.min(0.8, 0.55 + 0.08 * (info.count - config.repeatEditMin)),
        turnIndex: at,
        why: `${p} 被改了 ${info.count} 次 —— 一次没改对，通常说明动手前没想清楚`,
        evidence: dedupeEvidence(
          evidenceOf(turns.filter((_, i) => info.at.includes(i))),
          4,
        ),
      })
    }
  }

  // -- 4. 长调试 ------------------------------------------------------------
  {
    let run = 0
    let start = 0
    turns.forEach((t, i) => {
      const failed = t.toolCalls.filter(c => c.result?.ok === false).length
      if (failed > 0) {
        if (run === 0) start = i
        run += failed
        return
      }
      if (run >= config.longDebugMinFailures) {
        bump('long_debug')
        signals.push({
          kind: 'long_debug',
          confidence: 0.7,
          turnIndex: start,
          why: `连着 ${run} 次命令失败 —— 这段是典型的「试错式排查」`,
          evidence: dedupeEvidence(evidenceOf(turns.slice(start, i + 1))),
        })
      }
      run = 0
    })
  }

  // -- 5. 用户说「学到了」--------------------------------------------------
  {
    turns.forEach((t, i) => {
      if (t.role !== 'human' || !LEARNED_RE.test(t.text)) return
      bump('learned')
      signals.push({
        kind: 'learned',
        confidence: 0.9,
        turnIndex: i,
        why: '你自己说了「原来如此」—— 这是你亲口认证过的收获',
        evidence: [],
        userWords: t.text,
      })
    })
  }

  // -- 6. 用户说出了自己的判断（提问层的产物）------------------------------
  {
    const preds = predictionsFrom(session.turns)
    preds.forEach(prediction => {
      const idx = turns.findIndex(t => t.role === 'human' && t.text.includes(prediction.slice(0, 30)))
      if (idx === -1) return
      bump('user_prediction')
      signals.push({
        kind: 'user_prediction',
        confidence: 0.75,
        turnIndex: idx,
        why: '动手之前你说过自己打算怎么做 —— 卡片的「我自己的表述」一节直接用这句',
        evidence: [],
        userWords: prediction,
      })
    })
  }

  // 总闸：琐事任务不放行。避免知识库被「跑一下命令」灌满。
  const gated = signals.filter(s => {
    const turn = turns[s.turnIndex]
    if (turn === undefined) return true
    // 有用户原话的信号一律放行 —— worthCoaching 是给「任务请求」判的，不是给纠正判的
    if (s.userWords !== undefined) return true
    const first = turns.find(t => t.role === 'human')
    return first === undefined || worthCoaching(first.text)
  })

  const kept = gated
    .filter(s => s.confidence >= config.emitMinConfidence)
    .sort((a, b) => b.confidence - a.confidence || a.turnIndex - b.turnIndex)

  return { signals: kept, scanned }
}

/**
 * 卡点检测的轻量版 —— 只回答「这轮要不要提醒一句」。
 *
 * 跑在 UserPromptSubmit 上，预算 <100ms，所以**只吃已经解析好的少量事实**，
 * 不重新扫会话。返回 null 表示闭嘴（绝大多数时候都该是 null）。
 *
 * ★ 前缀是 `[coach-kb]` 而不是 `[coach]`：旧 dev-mod 那套协议往上下文里钉的
 *   正是 `[coach] 阶段 A:…`,用的词也是「先别动文件」。两边都叫 coach 的话,
 *   模型会把沉淀层的提醒读成提问层的阶段指令,而用户看到两条同样开头的话
 *   也无从分辨是谁说的。共存的前提是先分得清。
 */
export interface NudgeInput {
  /** 本轮之前，尾部窗口里各报错签名出现了几次。 */
  errorCounts: Map<string, number>
  /** 用户刚提交的这句话。 */
  prompt: string
  /** 上一轮有没有动过文件。 */
  touchedFiles: boolean
  /** 已经提醒过的签名，避免同一个坑反复念。 */
  alreadyNudged: Set<string>
  /** 这句话命中的旧卡（已在 matchRecall 里按 alreadyNudged 过滤过）。 */
  recall?: RecallHit | null
}

export interface Nudge {
  /** 一行，≤120 字，无感叹号。 */
  text: string
  /** 用来记账的 key。 */
  key: string
}

export function nudgeFor(input: NudgeInput): Nudge | null {
  const { errorCounts, prompt, touchedFiles, alreadyNudged } = input

  for (const [sig, n] of errorCounts) {
    if (n < 2) continue
    if (alreadyNudged.has(sig)) continue
    return {
      text: `[coach-kb] 同一个报错出现 ${n} 次了。先别让我改 —— 用一句话说:你觉得根因在哪?`,
      key: sig,
    }
  }

  if (CORRECTION_RE.test(prompt) && touchedFiles) {
    const key = `correction:${prompt.slice(0, 40)}`
    if (alreadyNudged.has(key)) return null
    return {
      text: '[coach-kb] 你刚才纠正了我。改之前先用一句话讲清你要的是什么 —— 这句话就是卡片。',
      key,
    }
  }

  // 旧卡命中排在「没懂」前面：他记过这条，先让他自己想起来，比从头追问便宜。
  const hit = input.recall
  if (hit !== undefined && hit !== null) {
    const { id, title } = hit.entry
    return {
      text: `[coach-kb] 这句话碰到了你记过的卡「${title}」(${id})。先别翻卡、也别让我答 —— 你凭记忆说说当时的结论?说完再 kb --show ${id} 对照,档位你自己定(/coach-kb:due 的规矩)。`,
      key: `recall:${id}`,
    }
  }

  if (CONFUSED_RE.test(prompt)) {
    const key = `confused:${prompt.slice(0, 40)}`
    if (alreadyNudged.has(key)) return null
    return {
      text: '[coach-kb] 你说没懂。我先不直接讲答案,按 /coach-kb:coach 一次只问一个问题,你自己推出来的才是你的。',
      key,
    }
  }

  return null
}
