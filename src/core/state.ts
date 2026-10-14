// 状态文件（~/knowledge/.coach/state.json）。
//
// 它存在的唯一理由是**幂等**：
//   · sessions{} 的水位线让「同一场会话跑第二遍」直接跳过，
//   · hook 的 firedKeys 让同一个坑不被反复念，
//   · counters 让 digest 不必重扫全部会话。
//
// 丢了它也不会坏 —— 卡片 id 是确定性的（见 ids.ts），重跑只会得到同一批卡。
// 这个「丢了也能重建」的性质让 state 可以放心地被当成缓存，而不是数据库。

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { kbPaths } from './paths.ts'

export interface SessionCursor {
  path: string
  size: number
  mtimeMs: number
  /** 已经处理到第几行。 */
  lines: number
  lastProcessedAt: string
  cardsEmitted: string[]
}

export interface CoachStateFile {
  version: number
  sessions: Record<string, SessionCursor>
  counters: { byDate: Record<string, number>; byType: Record<string, number> }
  hook: {
    lastFiredAt?: string
    firedDate: string
    firedToday: number
    /** key → 时间戳（秒）。冷却靠它。 */
    firedKeys: Record<string, number>
  }
  digest: {
    lastRunAt?: string
    lastReport?: string
    spentDate: string
    spentTodayUsd: number
    /**
     * 按天的花费流水，YYYY-MM-DD → 美元。
     *
     * `spentTodayUsd` 只留得住今天，而周报要回答的是「这一周花了多少」——
     * 不记流水的话，周报只能报一个数，而且是错的那个。只留 60 天：
     * 再往前的逐日金额没有用，而 state 是每次整份覆盖写的，让它无限长
     * 等于每次 distill 都多写一遍历史。
     */
    spendByDate: Record<string, number>
  }
  brain: { chosen: string; enabled: boolean; maxUsdPerDay: number; bench?: Record<string, unknown> }
  install: { installedAt?: string; slots: Record<string, string> }
}

export function defaultState(): CoachStateFile {
  return {
    version: 1,
    sessions: {},
    counters: { byDate: {}, byType: {} },
    hook: { firedDate: '', firedToday: 0, firedKeys: {} },
    digest: { spentDate: '', spentTodayUsd: 0, spendByDate: {} },
    brain: { chosen: 'none', enabled: false, maxUsdPerDay: 0.5 },
    install: { slots: {} },
  }
}

/**
 * 读状态。
 *
 * **必须逐字段合并，不能用 `{...default, ...parsed}`。** 浅展开只覆盖顶层：
 * 存盘的 `hook` 只要少一个 `firedToday`（旧版本写的、或者上次写盘时字段
 * 还没加），展开后整个 hook 被替换掉，`firedToday` 就成了 undefined，
 * 后面 `firedToday += 1` 静默变成 NaN —— 冷却逻辑从此失效且不报错。
 * 状态文件是缓存，缓存读坏了必须能自愈。
 */
export function loadState(kb: string): CoachStateFile {
  const base = defaultState()
  let parsed: Partial<CoachStateFile>
  try {
    parsed = JSON.parse(readFileSync(kbPaths(kb).state, 'utf8')) as Partial<CoachStateFile>
  } catch {
    return base
  }
  if (parsed === null || typeof parsed !== 'object') return base

  return {
    version: parsed.version ?? base.version,
    sessions: parsed.sessions ?? base.sessions,
    counters: {
      byDate: parsed.counters?.byDate ?? base.counters.byDate,
      byType: parsed.counters?.byType ?? base.counters.byType,
    },
    hook: {
      ...base.hook,
      ...(parsed.hook ?? {}),
      firedKeys: parsed.hook?.firedKeys ?? base.hook.firedKeys,
    },
    digest: { ...base.digest, ...(parsed.digest ?? {}), spendByDate: parsed.digest?.spendByDate ?? base.digest.spendByDate },
    brain: { ...base.brain, ...(parsed.brain ?? {}) },
    install: { ...base.install, ...(parsed.install ?? {}), slots: parsed.install?.slots ?? base.install.slots },
  }
}

/** 原子写：先写同目录的临时文件再 rename。半截的 state.json 比没有更糟。 */
export function saveState(kb: string, state: CoachStateFile): void {
  const path = kbPaths(kb).state
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
  renameSync(tmp, path)
}

/** 今天的日期，YYYY-MM-DD（本地时区）。 */
export function today(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/**
 * 日期字符串加减天数。
 *
 * 内部走 UTC —— 本地时区做日期加减会踩夏令时：那天只有 23 小时，
 * `setDate(+1)` 有可能落回同一天。日期字符串本身没有时区，
 * 用 UTC 运算就绕开了这件事，出来的还是同格式的日期串。
 */
export function shiftDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * ISO 8601 周号（周一为一周之始，含当年第一个周四的那周是第 1 周）。
 * 用来给 digests/<年>-W<周>.md 起名 —— 只有这一个用途，所以不追求通用。
 *
 * ★ 返回的 `year` 不一定等于日期里的年：2027-01-01 属于 2026-W53。
 * 所以返回的是两个字段，调用方别自己 slice 日期串的年。
 */
export function isoWeek(dateStr: string): { year: number; week: number } {
  const d = new Date(`${dateStr}T00:00:00Z`)
  // 挪到本周的周四：ISO 规定周号由「这一周的周四属于哪一年」决定。
  const day = (d.getUTCDay() + 6) % 7 // 周一=0
  d.setUTCDate(d.getUTCDate() - day + 3)
  const year = d.getUTCFullYear()
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const jan4Day = (jan4.getUTCDay() + 6) % 7
  const week1Thu = new Date(Date.UTC(year, 0, 4 - jan4Day + 3))
  const week = Math.round((d.getTime() - week1Thu.getTime()) / (7 * 86400000)) + 1
  return { year, week }
}
