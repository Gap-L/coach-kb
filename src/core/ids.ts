// 卡片 id。
//
// **确定性是这个文件的全部意义。** 旧实现的落盘不可靠是一回事，重复落盘是
// 另一回事：如果 id 里带上时间戳，同一次会话复盘两次就会得到两张卡，一周后
// 知识库里全是双胞胎。id 只由「会话 + 第几轮 + 哪条信号」决定，于是
//   删掉 state.json 重跑 ⇒ 卡片目录字节不变。
// 这条性质是幂等的地基（见 test/ids.test.ts）。

import { createHash } from 'node:crypto'

export type CardType = 'concept' | 'pattern' | 'pitfall' | 'playbook'

export const CARD_TYPES: CardType[] = ['concept', 'pattern', 'pitfall', 'playbook']

export function isCardType(s: string): s is CardType {
  return (CARD_TYPES as string[]).includes(s)
}

/**
 * @param type      卡片类型
 * @param sessionKey 会话的稳定标识（host:sessionId）
 * @param turnIndex  信号落在第几轮
 * @param kind       信号类型
 */
export function cardId(type: CardType, sessionKey: string, turnIndex: number, kind: string): string {
  // 分隔符用 NUL 而不是 `#`：sessionKey 里可能出现任何可打印字符，
  // 用 `#` 拼会有歧义 —— ("a#1", 2, "b") 和 ("a", 1, "2#b") 会撞成同一个 id。
  // NUL 不可能出现在三者中的任何一个里，拼接因此无歧义。
  const h = createHash('sha256')
    .update([sessionKey, String(turnIndex), kind].join('\u0000'))
    .digest('hex')
    .slice(0, 6)
  return `kb-${type}-${h}`
}

/** 文件名里那一段可读的 slug。只影响文件名，不影响 id。 */
export function slugify(s: string, max = 40): string {
  const out = s
    .toLowerCase()
    .replace(/[\s_/\\]+/g, '-')
    // 标点换成 `-` 而不是删掉：删掉会把词粘起来（`auth.ts` → `authts`），
    // 而 slug 的唯一作用就是可读。
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return out.slice(0, max).replace(/-$/, '') || 'card'
}

export function fileNameFor(id: string, slug: string): string {
  return `${id}-${slug}.md`
}

/** 从文件名里取回 id（`kb-pitfall-a3f91c-一句话.md` → `kb-pitfall-a3f91c`）。 */
export function idFromFileName(file: string): string | null {
  const m = file.match(/^(kb-[a-z]+-[0-9a-f]{6})/)
  return m?.[1] ?? null
}
