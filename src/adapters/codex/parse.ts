// Codex 会话日志（~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl）→ IR。
//
// 实测（本机 15 个文件 / 5,216 行）：信封很稳，每一行都是
//     { timestamp, ordinal, type, payload }
// 但 `type` / `payload.type` 的全集没有 schema，版本间会变。所以写法与
// Claude Code 那边一致：**只依赖信封 + 少数几种 payload，其余计数上报。**
//
// 只读 response_item 里的四种：
//   message(role=user)         真人输入（要剥掉 AGENTS.md / environment_context 这类注入）
//   message(role=assistant)    AI 正文
//   function_call / custom_tool_call           工具调用
//   function_call_output / custom_tool_call_output  工具结果，靠 call_id 回填
// event_msg 一律不读 —— item_completed 与 response_item 内容重复，读两遍会让
// 同一句话变成两个 turn。
//
// ★ 工具名**归一化成 Claude Code 的名字**（exec_command → Bash，apply_patch → Edit）。
//   signals.ts 的规则（反复改同一处、同一错误复现）按工具名判定，归一化之后
//   一行规则代码都不用改，两个宿主的卡片也才可比。

import { stat } from 'node:fs/promises'
import { readHead, readLines } from '../../core/lines.ts'
import type { Evidence, Session, ToolCall, ToolResult, Turn } from '../../core/model.ts'
import { emptySession } from '../../core/model.ts'
import { redactText } from '../../core/redact.ts'
import { clip, errorSignature, pickErrorLine, stripNoise } from '../claude-code/parse.ts'

interface RawBlock {
  type?: string
  text?: string
}

interface RawPayload {
  type?: string
  role?: string
  content?: RawBlock[] | null
  name?: string
  arguments?: string
  input?: string
  call_id?: string
  output?: unknown
  // session_meta
  id?: string
  session_id?: string
  cwd?: string
  timestamp?: string
  git?: { branch?: string }
  source?: unknown
  thread_source?: string
}

interface RawRow {
  timestamp?: string
  type?: string
  payload?: RawPayload
}

/** 认识但故意不看的顶层类型。 */
const IGNORED_TOP = new Set(['event_msg', 'token_usage_record', 'turn_context', 'world_state', 'session_meta'])
/** 认识但故意不看的 response_item 子类型。reasoning 是加密的，读不了。 */
const IGNORED_ITEM = new Set(['reasoning', 'web_search_call'])

/**
 * Codex 往 user 角色里塞的框架注入。它们不是人说的话，留着会污染
 * 「用户纠正了 AI」这类信号（实测每场会话开头都有 2 段）。
 */
const INJECTED_RE =
  /^\s*(?:# AGENTS\.md instructions|<environment_context>|<turn_aborted>|<permissions instructions>|<codex_internal_context|<user_instructions>)/
/** 贴图时 Codex 把图片包成 `<image name=… path=…>` … `</image>` 两个文本块,只剥外壳。 */
const IMAGE_TAG_RE = /<image\b[^>]*>|<\/image>/g

/**
 * 按**文本块**判定,不按整条消息:一条消息里可能先是图片标签、再是真话,
 * 整条判会把带图的提问整个丢掉(实测踩到过)。
 */
export function codexHumanText(blocks: string[] | string): string {
  const list = typeof blocks === 'string' ? [blocks] : blocks
  return list
    .map(b => stripNoise(b).trim())
    .filter(b => b !== '' && !INJECTED_RE.test(b))
    .map(b => b.replace(IMAGE_TAG_RE, '').trim())
    .filter(b => b !== '')
    .join('\n')
}

// ---------------------------------------------------------------------------
// 工具调用归一化
// ---------------------------------------------------------------------------

const PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm

/** apply_patch 正文 → 动到的文件列表。 */
export function patchFiles(patch: string): string[] {
  const out: string[] = []
  for (const m of patch.matchAll(PATCH_FILE_RE)) {
    const p = m[1]?.trim()
    if (p !== undefined && p !== '' && !out.includes(p)) out.push(p)
  }
  return out
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {}
  try {
    const v = JSON.parse(raw) as unknown
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** exec_command 是 `cmd: string`；老版本的 shell 工具是 `command: string[]`。 */
function commandOf(args: Record<string, unknown>): string | undefined {
  const cmd = args['cmd'] ?? args['command']
  if (typeof cmd === 'string') return cmd
  if (Array.isArray(cmd)) {
    const parts = cmd.filter((x): x is string => typeof x === 'string')
    // ["bash","-lc","真正的命令"] —— 取最后一段才是人写的
    if (parts.length >= 3 && /^(ba|z)?sh$/.test(parts[0] ?? '') && parts[1]?.startsWith('-')) return parts.slice(2).join(' ')
    return parts.join(' ')
  }
  return undefined
}

/**
 * 一次 Codex 调用 → 一个或多个 Claude 形状的 ToolCall。
 * apply_patch 一次能动多个文件，拆成多个 Edit，「反复改同一处」才数得对。
 */
export function normalizeCall(
  name: string,
  rawArgs: string | undefined,
  callId: string,
  clean: (s: string) => string,
): ToolCall[] {
  const args = name === 'apply_patch' && rawArgs !== undefined && !rawArgs.trim().startsWith('{')
    ? { input: rawArgs }
    : parseArgs(rawArgs)

  let patch: string | undefined
  if (name === 'apply_patch') patch = typeof args['input'] === 'string' ? args['input'] : rawArgs
  const cmd = commandOf(args)
  if (patch === undefined && cmd !== undefined && /^\s*apply_patch\b/.test(cmd)) patch = cmd

  if (patch !== undefined) {
    const files = patchFiles(patch)
    if (files.length === 0) return [{ id: callId, name: 'Edit', input: {}, result: null }]
    return files.map((f, i) => ({
      id: i === 0 ? callId : `${callId}#${i}`,
      name: 'Edit',
      input: { file_path: clean(f) },
      result: null,
    }))
  }

  if (cmd !== undefined) {
    const input: Record<string, unknown> = { command: clean(clip(cmd, 4000)) }
    if (typeof args['workdir'] === 'string') input['workdir'] = args['workdir']
    return [{ id: callId, name: 'Bash', input, result: null }]
  }

  // MCP 等其他工具：原名保留，入参压成短串
  const input: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') input[k] = clean(clip(v, 600))
    else if (typeof v === 'number' || typeof v === 'boolean') input[k] = v
  }
  return [{ id: callId, name, input, result: null }]
}

// ---------------------------------------------------------------------------
// 工具结果
// ---------------------------------------------------------------------------

export interface CodexOutput {
  exitCode: number | null
  body: string
}

/**
 * 两种实测形状：
 *   exec_command  "Chunk ID: …\nProcess exited with code 1\n…\nOutput:\n<正文>"
 *   老 shell 工具  '{"output":"…","metadata":{"exit_code":1}}'
 * 都不是就当纯文本。
 */
export function readOutput(raw: unknown): CodexOutput {
  let text = ''
  if (typeof raw === 'string') text = raw
  else if (Array.isArray(raw)) {
    text = raw.map(b => (b as RawBlock)?.text).filter((t): t is string => typeof t === 'string').join('\n')
  } else if (raw !== null && typeof raw === 'object') text = JSON.stringify(raw)

  const t = text.trim()
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t) as { output?: unknown; metadata?: { exit_code?: unknown } }
      if (typeof j.output === 'string') {
        const code = j.metadata?.exit_code
        return { exitCode: typeof code === 'number' ? code : null, body: j.output }
      }
    } catch {
      /* 不是 JSON，按纯文本走 */
    }
  }

  const m = text.match(/Process exited with code (\d+)/)
  const at = text.indexOf('\nOutput:\n')
  return {
    exitCode: m?.[1] === undefined ? null : Number(m[1]),
    body: at === -1 ? text : text.slice(at + '\nOutput:\n'.length),
  }
}

const PATCH_FAIL_RE = /^(?:error|failed|apply_patch verification failed|invalid patch)/i

export function codexResult(call: ToolCall, raw: unknown, clean: (s: string) => string): ToolResult {
  const { exitCode, body } = readOutput(raw)
  const evidence: Evidence[] = []

  if (call.name === 'Bash') {
    const cmd = call.input['command']
    if (typeof cmd === 'string') evidence.push({ kind: 'command', text: clip(cmd, 300) })
  } else if (call.name === 'Edit') {
    const p = call.input['file_path']
    if (typeof p === 'string') evidence.push({ kind: 'file', text: p })
  } else {
    const p = call.input['path'] ?? call.input['file_path']
    if (typeof p === 'string') evidence.push({ kind: 'file', text: p })
  }

  const failed = call.name === 'Edit' ? PATCH_FAIL_RE.test(body.trim()) : exitCode !== null && exitCode !== 0
  if (!failed) return { ok: true, evidence }

  const head = clean(body.trim() === '' ? `exit code ${exitCode ?? '?'}` : body)
  const line = pickErrorLine(head)
  if (line !== null) evidence.push({ kind: 'output', text: clip(line, 300) })
  const sig = errorSignature(head)
  return {
    ok: false,
    ...(sig === null ? {} : { errorSig: sig }),
    errorHead: clip(stripNoise(head), 200),
    evidence,
  }
}

// ---------------------------------------------------------------------------
// 主解析
// ---------------------------------------------------------------------------

export interface CodexHeader {
  sessionId: string
  cwd?: string
  gitBranch?: string
  startedAt?: string
  /** 子代理（/review 之类）派生的线程 —— 不是人开的会话。 */
  subagent: boolean
}

export function readCodexHeader(path: string): CodexHeader {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const fromName = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/)?.[1]
  const out: CodexHeader = { sessionId: fromName ?? base.replace(/\.jsonl$/, ''), subagent: false }
  // session_meta 一行就可能有几十 KB（base_instructions 全文在里面），读大一点
  for (const line of readHead(path, 256 * 1024).split('\n').slice(0, 20)) {
    if (!line.includes('"session_meta"') && !line.includes('"turn_context"')) continue
    try {
      const row = JSON.parse(line) as RawRow
      const p = row.payload ?? {}
      if (out.cwd === undefined && typeof p.cwd === 'string') out.cwd = p.cwd
      if (row.type !== 'session_meta') continue
      const id = p.session_id ?? p.id
      if (typeof id === 'string') out.sessionId = id
      if (out.startedAt === undefined) out.startedAt = p.timestamp ?? row.timestamp
      if (typeof p.git?.branch === 'string') out.gitBranch = p.git.branch
      if (p.thread_source === 'subagent') out.subagent = true
    } catch {
      /* 被 readHead 截断的半行 */
    }
  }
  return out
}

export interface CodexParseOptions {
  redact?: boolean
}

export async function parseCodexSession(path: string, opts: CodexParseOptions = {}): Promise<Session> {
  const { redact = true } = opts
  const st = await stat(path)
  const header = readCodexHeader(path)
  const session = emptySession('codex', path, header.sessionId)
  session.size = st.size
  if (header.cwd !== undefined) session.cwd = header.cwd
  if (header.gitBranch !== undefined) session.gitBranch = header.gitBranch
  if (header.startedAt !== undefined) session.startedAt = header.startedAt
  if (header.subagent) session.warnings.push('这是 Codex 子代理线程(如 /review),不是你直接开的会话')

  const clean = (s: string): string => (redact ? redactText(s).text : s)
  const count = (k: string): void => {
    session.unknownTypes[k] = (session.unknownTypes[k] ?? 0) + 1
  }

  /** call_id → 这次调用拆出来的全部 ToolCall（apply_patch 可能不止一个）。 */
  const pending = new Map<string, ToolCall[]>()
  /** 当前这一轮 AI 的回合。真人一开口就换新的。 */
  let current: Turn | null = null
  let lastNo = 0

  const assistantTurn = (ts: string | undefined): Turn => {
    if (current === null) {
      current = { role: 'assistant', text: '', toolCalls: [], isSidechain: header.subagent }
      if (ts !== undefined) current.ts = ts
      session.turns.push(current)
    }
    return current
  }

  for await (const { line, no } of readLines(path)) {
    lastNo = no
    if (line.trim() === '') continue
    let row: RawRow
    try {
      row = JSON.parse(line) as RawRow
    } catch {
      count('__parse_error__')
      continue
    }

    const top = row.type ?? '__no_type__'
    if (top === 'compacted') {
      // 上下文被压缩过 —— 之前的行可能不全。水位线不连续，要说出来。
      session.warnings.push(`第 ${no} 行:上下文被压缩过,之前的内容可能不完整`)
      count(top)
      continue
    }
    if (top !== 'response_item') {
      count(IGNORED_TOP.has(top) ? top : `?${top}`)
      continue
    }

    const p = row.payload ?? {}
    const kind = p.type ?? '__no_payload_type__'

    if (kind === 'message') {
      const blocks = Array.isArray(p.content) ? p.content : []
      const texts = blocks
        .filter(b => (b?.type === 'input_text' || b?.type === 'output_text' || b?.type === 'text') && typeof b.text === 'string')
        .map(b => b.text as string)
      const text = texts.join('\n')
      if (p.role === 'user') {
        const body = codexHumanText(texts)
        if (body === '') continue
        const turn: Turn = { role: 'human', text: clean(body), toolCalls: [], isSidechain: header.subagent }
        if (row.timestamp !== undefined) turn.ts = row.timestamp
        session.turns.push(turn)
        current = null
      } else if (p.role === 'assistant') {
        const t = assistantTurn(row.timestamp)
        const body = clean(stripNoise(text).trim())
        if (body !== '') t.text = t.text === '' ? body : `${t.text}\n\n${body}`
      }
      // developer / system 角色是框架注入，不看
      continue
    }

    if (kind === 'function_call' || kind === 'custom_tool_call') {
      const callId = p.call_id ?? `${no}`
      const calls = normalizeCall(p.name ?? 'unknown', p.arguments ?? p.input, callId, clean)
      assistantTurn(row.timestamp).toolCalls.push(...calls)
      pending.set(callId, calls)
      continue
    }

    if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
      const calls = p.call_id === undefined ? undefined : pending.get(p.call_id)
      if (calls === undefined) continue
      for (const c of calls) c.result = codexResult(c, p.output, clean)
      pending.delete(p.call_id as string)
      continue
    }

    count(IGNORED_ITEM.has(kind) ? kind : `?${kind}`)
  }

  session.lines = lastNo
  session.turns = session.turns.filter(t => t.text !== '' || t.toolCalls.length > 0)
  const last = session.turns[session.turns.length - 1]
  if (last?.ts !== undefined) session.endedAt = last.ts

  // 没等到输出的调用（会话中断）：证据照留
  for (const calls of pending.values()) {
    for (const c of calls) if (c.result === null) c.result = codexResult(c, '', clean)
  }
  return session
}
