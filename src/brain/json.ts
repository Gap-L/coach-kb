// 从模型的自由文本里抠出 JSON。
//
// 实测：`claude -p --output-format json` 的 stdout **不是纯 JSON** ——
// 前面会先来一行 `[claude-code:unrecognized_model] {...}` 之类的告警。
// 而模型返回的正文也常常裹着 ```json 围栏、前后带客套话。
//
// 这里的立场：**能救则救，救不了就明确报错**。
// 绝不「猜一个差不多的结构出来」—— 猜出来的卡片会带着编造的因果进知识库，
// 那比没有卡片坏得多（用户会以为那是自己学到的东西）。

/** 从一段文本里找出第一个**配平**的 JSON 数组或对象。 */
export function extractJson(text: string): unknown {
  const cleaned = stripFences(text)

  // 按「哪个开括号先出现」排序，而不是固定先试 `[`。
  // 固定顺序会踩这个坑：`前置 {"drafts":[]}` 里第一个 `[` 是对象**内部**那个，
  // 于是会返回一个空的 `[]` 而不是整个对象 —— 看着解析成功了，其实丢光了内容。
  const pairs = [
    { open: '[', close: ']', at: cleaned.indexOf('[') },
    { open: '{', close: '}', at: cleaned.indexOf('{') },
  ]
    .filter(p => p.at !== -1)
    .sort((a, b) => a.at - b.at)

  for (const { open, close, at } of pairs) {
    const end = matchBracket(cleaned, at, open, close)
    if (end === -1) continue
    try {
      return JSON.parse(cleaned.slice(at, end + 1)) as unknown
    } catch {
      /* 这一对不行，试下一个（外层的对象坏了，内层的数组可能还能用） */
    }
  }

  // 整体就是 JSON 的情况（对象或数组都行）
  try {
    return JSON.parse(cleaned.trim()) as unknown
  } catch {
    return null
  }
}

/** 去掉 ``` 围栏，但保留围栏里的内容。 */
function stripFences(text: string): string {
  return text.replace(/```[a-zA-Z]*\s*\n?([\s\S]*?)```/g, (_, body: string) => body)
}

/**
 * 从 `start` 处的 open 字符找到配对的 close 字符，跳过字符串字面量里的括号
 * 与转义。手写而不是用正则 —— 正则数不清嵌套层数。
 */
function matchBracket(text: string, start: number, open: string, close: string): number {
  let depth = 0
  let inStr = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * 从 `claude -p --output-format json` 的 stdout 里取出模型正文。
 *
 * 逐行找 `type: "result"` 的那个对象 —— 告警行、进度行都会被跳过。
 * 返回 null 表示这次调用没有可用的正文。
 */
export function readResultPayload(stdout: string): { text: string; usage?: { inputTokens: number; outputTokens: number; costUsd: number }; isError: boolean } | null {
  let best: Record<string, unknown> | null = null
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object') continue
    const obj = parsed as Record<string, unknown>
    if (obj['type'] === 'result') best = obj
  }
  if (best === null) return null

  const u = best['usage'] as Record<string, unknown> | undefined
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    text: typeof best['result'] === 'string' ? best['result'] : '',
    isError: best['is_error'] === true || best['subtype'] === 'error',
    usage: {
      inputTokens: num(u?.['input_tokens']),
      outputTokens: num(u?.['output_tokens']),
      costUsd: num(best['total_cost_usd']),
    },
  }
}

/** 裁到 n 个字符，用于把过长的模型返回塞进错误信息里。 */
export function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length <= n ? one : one.slice(0, n - 1) + '…'
}
