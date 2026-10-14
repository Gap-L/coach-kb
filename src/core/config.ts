// 用户可改的配置（`~/knowledge/.coach/config.json`）。
//
// 为什么和 state.json 分开放:state 是**机器生成的缓存**,每次写盘都是整个
// 覆盖;config 是**人改的意图**。混在一个文件里,任何一次状态写盘都会把
// 用户手写的配置冲掉 —— 而且不报错。所以两者从一开始就分开。
//
// 读法沿用 state.ts 那条教训:**逐字段合并,不能浅展开**。浅展开只覆盖顶层,
// 用户配置里少写一个 `minGapSeconds`(老版本写的、或他手删了)就会变成
// undefined,后面 `now - minGap` 静默变 NaN,比较永远为 false —— 提醒从此
// 不再有冷却,而且不报错。配置读坏了必须能自愈。

import { readFileSync } from 'node:fs'
import { kbPaths } from './paths.ts'

export interface CoachConfig {
  hook: {
    /** 总开关。false = 一次都不提醒。 */
    enabled: boolean
    /** 两次提醒之间的最小间隔(秒)。 */
    minGapSeconds: number
    /** 每天最多提醒几次。 */
    maxPerDay: number
    /** 只读 transcript 尾部这么多字节。别调大 —— 它在 <100ms 预算里。 */
    tailBytes: number
    /** 同一条信号多久之内不重复提醒(秒)。 */
    cooldownSeconds: number
    /** 用户提到记过的知识点时，提醒他先凭记忆复述。 */
    recall: boolean
  }
}

export const DEFAULT_CONFIG: CoachConfig = {
  hook: {
    enabled: true,
    minGapSeconds: 600,
    maxPerDay: 6,
    // 256KB ≈ 最近几十个回合。报错计数只需要最近这一段,
    // 而它决定的是**读盘量**,直接压在 hook 的预算上。
    tailBytes: 256 * 1024,
    cooldownSeconds: 24 * 3600,
    recall: true,
  },
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback
}

export function loadConfig(kb: string): CoachConfig {
  const base = DEFAULT_CONFIG
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(kbPaths(kb).config, 'utf8'))
  } catch {
    return base
  }
  if (parsed === null || typeof parsed !== 'object') return base
  const h = (parsed as { hook?: unknown }).hook
  if (h === null || typeof h !== 'object') return base
  const hook = h as Record<string, unknown>
  return {
    hook: {
      enabled: typeof hook['enabled'] === 'boolean' ? hook['enabled'] : base.hook.enabled,
      minGapSeconds: num(hook['minGapSeconds'], base.hook.minGapSeconds),
      maxPerDay: num(hook['maxPerDay'], base.hook.maxPerDay),
      tailBytes: num(hook['tailBytes'], base.hook.tailBytes),
      cooldownSeconds: num(hook['cooldownSeconds'], base.hook.cooldownSeconds),
      recall: typeof hook['recall'] === 'boolean' ? hook['recall'] : base.hook.recall,
    },
  }
}

/** 写一份带注释的默认配置,给 `coach install` 用。已存在就不覆盖。 */
export function renderDefaultConfig(): string {
  return (
    JSON.stringify(
      {
        _说明: [
          'hook.enabled=false 可以彻底关掉卡点提醒。',
          'minGapSeconds / maxPerDay 是克制用的闸门 —— 提醒的价值在于稀,不在于多。',
          'tailBytes 决定 hook 每次读多少会话尾部,调大要自己承担延迟。',
          'recall=false 关掉「提到记过的知识点时先凭记忆复述」那条提醒。',
        ],
        hook: DEFAULT_CONFIG.hook,
      },
      null,
      2,
    ) + '\n'
  )
}
