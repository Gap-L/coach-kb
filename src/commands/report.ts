// `coach report` —— 给**没有可读会话**的宿主(WorkBuddy)自己上报一张卡。
//
// 读侧做不了(见 docs/hosts.md),所以反过来:那边的 AI 把这场会话里的卡点
// 整理成一段 JSON,交给这条命令落盘。为什么要过 CLI 而不是让 AI 直接写 md:
//   · frontmatter 的字段、id 的算法、四节正文 —— 手写迟早写歪,写歪了 kb 读不出来
//   · 落盘前的密钥扫描只有一份实现(sink.ts / redact.ts),不能指望对面的 AI 记得
//   · `mine` 一律留空 —— 自报的卡同样要用户自己认领,规则不因宿主而松
//
// 输入(stdin 或 --file):
//   { "title": "...", "type": "pitfall|pattern|concept|playbook",
//     "why": "为什么挑中它", "evidence": ["文件:行号", "命令", "报错首行"],
//     "ai": "为什么会这样", "transfer": "下次第一步", "tags": ["..."] }
// 也可以是这样的对象组成的数组。

import { readFileSync } from 'node:fs'
import { newCard } from '../core/card.ts'
import { isCardType, type CardType } from '../core/ids.ts'
import { upsertCard, writeIndex } from '../core/kb.ts'
import { safeForCard } from '../core/redact.ts'
import type { Ctx } from './ctx.ts'
import { cleanEvidence } from './sink.ts'

const HOSTS = new Set(['workbuddy', 'cursor', 'codex', 'claude-code', 'unknown'])

interface Reported {
  title?: unknown
  type?: unknown
  why?: unknown
  evidence?: unknown
  ai?: unknown
  transfer?: unknown
  tags?: unknown
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export async function runReport(ctx: Ctx): Promise<number> {
  const { args, out, err } = ctx
  const host = args.get('host', 'workbuddy') as string
  if (!HOSTS.has(host)) {
    err(`✗ --host 只认 ${[...HOSTS].join(' / ')}`)
    return 2
  }

  let raw: string
  try {
    const file = args.get('file')
    raw = file !== undefined ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8')
  } catch (e) {
    err(`✗ 读不到输入:${(e as Error).message}`)
    return 2
  }

  let items: Reported[]
  try {
    const v = JSON.parse(raw) as unknown
    items = (Array.isArray(v) ? v : [v]) as Reported[]
  } catch {
    err('✗ 输入不是合法 JSON。格式见 coach --help 里 report 一节')
    return 2
  }

  const dry = args.bool('dry-run')
  const session = args.get('session') ?? `${host}-${new Date().toISOString().slice(0, 10)}`
  const cwd = args.get('cwd') ?? process.cwd()
  const date = new Date().toISOString().slice(0, 10)
  let bad = 0

  for (const [i, it] of items.entries()) {
    const title = str(it.title)
    if (title === '') {
      err(`  ✗ 第 ${i + 1} 条没有 title,跳过`)
      bad += 1
      continue
    }
    const t = str(it.type)
    const type: CardType = isCardType(t) ? t : 'pitfall'
    const card = newCard({
      type,
      title,
      // id 由「宿主:会话:标题」决定 —— 同一条重复上报会落到同一张卡上,不会越报越多
      sessionKey: `${host}:${session}`,
      turnIndex: 0,
      kind: `report:${title}`,
      why: str(it.why),
      evidence: cleanEvidence(strs(it.evidence)),
      tags: [...new Set([...strs(it.tags), host])].slice(0, 8),
      source: { tool: host, session, cwd, date },
      confidence: 0.5,
    })
    card.signals = ['self_report']
    card.ai = str(it.ai)
    card.transfer = str(it.transfer)

    const scan = safeForCard([card.title, card.why, card.ai, card.transfer, ...card.evidence].join('\n'))
    if (scan.masked) {
      err(`  ✗ ${title} —— 疑似密钥,拒绝落盘`)
      bad += 1
      continue
    }
    if (dry) {
      out(`  ＋ [${type}] ${title}  (dry-run,${card.id})`)
      continue
    }
    const r = upsertCard(ctx.kb, card)
    out(`  ${r.created ? '＋' : r.changed ? '↻' : '·'} [${type}] ${title}  ${card.id}`)
  }

  if (!dry) {
    const { total } = writeIndex(ctx.kb)
    out(`知识库共 ${total} 张卡。上报的卡是 status: inbox、来源 ${host} —— 证据是那边的 AI 写的,认领前多看一眼。`)
    out('认领:coach save --id <id> --my-words "你自己的话"')
  }
  return bad > 0 ? 1 : 0
}
