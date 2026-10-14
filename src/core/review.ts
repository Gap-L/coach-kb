// 复习排期。
//
// 这是整个工具的第三条腿：卡点被问出来、被你用自己的话认下之后，
// 还差一件 —— **它得知道下次什么时候来找你**。在这之前 `review.next`
// 没有任何写入方，于是「复习」是一次性对话：`kb --due` 只能退回
// 「落卡满 7 天」的兜底规则，复习过的卡第二天照样到期，永远到期。
//
// 这个文件只管两件纯事：**给定档位算出下一次排期**、**判断一张卡今天到不到期**。
// 写盘不在这里（在 core/kb.ts 的 setReview），因为写入器要和 findCard 待在一起，
// 放这边会形成循环依赖。
//
// 命名注意：这里的 "review" 指复习间隔，和 src/core/schedule.ts 无关 ——
// 那个是 macOS LaunchAgent 的每周 digest 定时器，两回事。

import type { Card, CardReview } from './card.ts'

/** 用户自己的说法 → 档位。三个档，多一个都不加。 */
export type Recall = 'solid' | 'fuzzy' | 'forgot'

/**
 * 算完的一条排期记录。三个字段**一定在场** ——
 * 注意它不是 `CardReview`（那个的 last/next 是可选的），
 * 返回可选字段会在写入点逼出一串 `!`。
 */
export interface ReviewSchedule {
  count: number
  last: string
  next: string
}

const DAY_MS = 86_400_000

/**
 * 「稳了」的阶梯：第 1 次 7 天，第 5 次起封顶 120 天。
 *
 * 是**查表不是算术**：7,14,30,60,120 并不是翻倍序列（14→30 而非 28），
 * 所以别把它写成 `7 * 2 ** (n-1)`。
 */
const SOLID_DAYS = [7, 14, 30, 60, 120] as const
const MAX_SOLID_DAYS = 120
/** 「模糊」固定 3 天：不奖励也不惩罚，就是过几天再问一次。 */
const FUZZY_DAYS = 3
/** 「没想起来」1 天后再来，同时把连续次数归零。 */
const FORGOT_DAYS = 1
/** 从没定过档的卡，落卡满这么多天算第一次到期 —— 引导用，不是排期。 */
const BOOTSTRAP_DAYS = 7

/**
 * 档位别名。用户会说中文，AI 会把他的话原样传进来，两种写法都得认。
 *
 * 「没想起来」特意多收两个同义词：**被拒绝代价最大的那一刻，
 * 正是用户承认自己没想起来的时候** —— 这时候弹一句「不认识的档位」
 * 会把最脆弱的一步变成摩擦。规范档位（稳了/模糊）不扩同义词。
 */
const RECALL_ALIASES: Record<string, Recall> = {
  '稳了': 'solid',
  solid: 'solid',
  '模糊': 'fuzzy',
  fuzzy: 'fuzzy',
  '没想起来': 'forgot',
  '想不起来': 'forgot',
  '忘了': 'forgot',
  forgot: 'forgot',
}

/** 认不出来就返回 null —— **绝不猜**。AI 该回去问用户，而不是替他把话翻译一遍。 */
export function parseRecall(raw: string): Recall | null {
  return RECALL_ALIASES[raw.trim().toLowerCase()] ?? null
}

/** UTC 的 YYYY-MM-DD。全库的日期比较都用这个口径。 */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function plusDays(now: Date, n: number): string {
  // 用 UTC 毫秒加，不碰本地时区 —— 跨月、跨年、夏令时都不会算错。
  return isoDay(new Date(now.getTime() + n * DAY_MS))
}

function solidDays(count: number): number {
  const rung = Math.min(Math.max(count, 1), SOLID_DAYS.length)
  return SOLID_DAYS[rung - 1] ?? MAX_SOLID_DAYS
}

/**
 * 纯函数：不改 `prev`、不读盘、`now` 显式传入。
 *
 * 一个刻意的非对称：`forgot` 把 count 归零，`fuzzy` 保持不动。
 * 归零是因为「没想起来」说明这条时间线不成立，下一次「稳了」得重新从 7 天起；
 * 保持不动是因为「模糊」既不该被当成学会，也不该被当成没学会 —— 惩罚它会让人
 * 不敢承认自己模糊，那这个档就没意义了。
 */
export function nextReview(prev: CardReview, grade: Recall, now: Date): ReviewSchedule {
  const last = isoDay(now)
  if (grade === 'forgot') return { count: 0, last, next: plusDays(now, FORGOT_DAYS) }
  if (grade === 'fuzzy') return { count: prev.count, last, next: plusDays(now, FUZZY_DAYS) }
  const count = prev.count + 1
  // count 会一直涨下去（它是真实的连续次数记录），只有间隔封顶。
  return { count, last, next: plusDays(now, solidDays(count)) }
}

// ---------------------------------------------------------------------------
// 到期判定
// ---------------------------------------------------------------------------

/** 定过档、且排期日已到（含「没认领的谈不上复习」这道闸门）。 */
export function isScheduledDue(card: Card, now: Date): boolean {
  if (card.status !== 'confirmed') return false
  const next = card.review.next
  if (next === undefined) return false
  return next <= isoDay(now)
}

/**
 * 从没定过档、但落卡满 7 天的 confirmed 卡。**只管引导第一次复习。**
 *
 * 注意它必须排除已有 `review.next` 的卡：一张 10 天前落的卡刚定了「稳了」
 * （下次 7 天后），如果这里还按落卡日期算，它明天就又被算成到期 ——
 * 那正是这个功能要修的病。
 */
export function bootstrapDue(card: Card, now: Date): boolean {
  if (card.status !== 'confirmed') return false
  if (card.review.next !== undefined) return false
  const born = card.source.date
  if (born === '') return false
  const days = (now.getTime() - new Date(born + 'T00:00:00').getTime()) / DAY_MS
  return days >= BOOTSTRAP_DAYS
}

/**
 * `kb --due` 用的完整规则：排期到了 **或** 从没排过但够老了。
 *
 * 索引（index.md 的「该复习了」）**只用 isScheduledDue，不用这个** ——
 * 理由见 docs/design.md：兜底是一次交互命令里的提示，
 * 不该让一个属于用户的文件在什么都没发生时自己变响。
 */
export function isDue(card: Card, now: Date): boolean {
  return isScheduledDue(card, now) || bootstrapDue(card, now)
}
