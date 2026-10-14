// 直连 endpoint 的脑子 —— 不走 agentic 运行时，因此没有那 ~17k tokens 的固定开销。
//
// 蒸馏是**非 agentic 任务**：给一段文本，要一段 JSON 回来。让一个带系统提示、
// 带工具 schema、带 MCP 配置的 agent 运行时来干这件事，等于每张卡都先付一遍
// 那些用不上的东西的钱。
//
// 这个脑子复用**环境里已经有的**配置（ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN），
// 不引入新的 key 管理 —— 读不到就明确报错，让调用方退回 claude 脑。
//
// ★ 密钥纪律（本机 ANTHROPIC_AUTH_TOKEN 是真密钥）：
//   · 只从环境读，绝不写进 state、绝不落盘、绝不出现在日志里
//   · **错误信息一律先过 scrub()** —— 端点报错时常常把 Authorization 回显回来，
//     不洗就等于把密钥打进了日志

import { buildPrompt, reconcile } from './prompt.ts'
import { clip, extractJson } from './json.ts'
import type { Brain, BrainOptions, BrainResult, DistillInput } from './types.ts'

interface Endpoint {
  base: string
  token: string
  model?: string
}

function readEndpoint(): Endpoint | null {
  const base = process.env['ANTHROPIC_BASE_URL']
  const token = process.env['ANTHROPIC_AUTH_TOKEN'] ?? process.env['ANTHROPIC_API_KEY']
  if (base === undefined || base === '' || token === undefined || token === '') return null
  const model = process.env['COACH_BRAIN_MODEL'] ?? process.env['ANTHROPIC_MODEL']
  return { base: base.replace(/\/+$/, ''), token, ...(model === undefined ? {} : { model }) }
}

/** 把密钥从任何要输出/落盘的文本里抹掉。错误路径上必须调用。 */
function scrub(text: string, secrets: string[]): string {
  let out = text
  for (const s of secrets) {
    if (s.length >= 8) out = out.split(s).join('«REDACTED:token»')
  }
  return out
}

export const httpBrain: Brain = {
  name: 'http',

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const ep = readEndpoint()
    if (ep === null) {
      return { ok: false, detail: '环境里没有 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN' }
    }
    return { ok: true, detail: `endpoint ${ep.base}（密钥已就位，未读取其值）` }
  },

  async distill(input: DistillInput, opts: BrainOptions): Promise<BrainResult> {
    const base: BrainResult = { brain: 'http', drafts: [] }
    const ep = readEndpoint()
    if (ep === null) {
      return { ...base, degraded: '没有可用的 endpoint 配置' }
    }

    const model = opts.model ?? ep.model
    if (model === undefined) {
      return { ...base, degraded: '没指定模型（设 COACH_BRAIN_MODEL 或用 --model）' }
    }

    const started = Date.now()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs)

    let res: Response
    try {
      res = await fetch(`${ep.base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': ep.token,
          authorization: `Bearer ${ep.token}`,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          messages: [{ role: 'user', content: buildPrompt(input) }],
        }),
        signal: ctrl.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      const why = err instanceof Error ? err.message : String(err)
      return { ...base, degraded: ctrl.signal.aborted ? `http 超时(${opts.timeoutMs}ms)` : scrub(why, [ep.token]) }
    }
    clearTimeout(timer)

    const ms = Date.now() - started
    const bodyText = await res.text().catch(() => '')

    if (!res.ok) {
      return { ...base, degraded: `endpoint 返回 ${res.status}: ${clip(scrub(bodyText, [ep.token]), 200)}` }
    }

    let body: unknown
    try {
      body = JSON.parse(bodyText)
    } catch {
      return { ...base, degraded: `endpoint 返回的不是 JSON: ${clip(scrub(bodyText, [ep.token]), 200)}` }
    }

    const content = (body as { content?: Array<{ type?: string; text?: string }> }).content
    const text = Array.isArray(content)
      ? content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
      : ''
    if (text.trim() === '') {
      return { ...base, degraded: 'endpoint 返回了空正文' }
    }

    const raw = extractJson(text)
    if (raw === null) {
      return { ...base, degraded: `模型没返回可解析的 JSON: ${clip(text, 200)}` }
    }

    const usageRaw = (body as { usage?: { input_tokens?: number; output_tokens?: number } }).usage
    const usage = {
      inputTokens: usageRaw?.input_tokens ?? 0,
      outputTokens: usageRaw?.output_tokens ?? 0,
      // 自建端点不报美元；留 0，由 brain bench 用 token 数另行估算
      costUsd: 0,
      ms,
    }

    const { drafts, dropped } = reconcile(raw, input.candidates)
    if (drafts.length === 0) {
      return { ...base, usage, degraded: `返回的条目一条都对不上候选表(${dropped.slice(0, 3).join('; ')})` }
    }

    return {
      brain: 'http',
      drafts,
      usage,
      ...(dropped.length === 0 ? {} : { degraded: `有 ${dropped.length} 条没补上: ${dropped.slice(0, 3).join('; ')}` }),
    }
  },
}
