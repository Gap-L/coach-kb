// Claude Code 会话日志（~/.claude/projects/<slug>/<sessionId>.jsonl）→ IR。
//
// 全部取舍都来自对着真实语料实测的一场会话（aebd09c8…，52 MB / 18,194 行）：
//
//   行类型     assistant 6150 · attachment 3967 · user 2920 · permission-mode 975
//              mode 975 · last-prompt 975 · atis-latch 975 · ai-title 974
//              file-history-delta 147 · queue-operation 92 · system 39 · cost-state 1
//   其中 user  2920 行里 **只有 3 行是真人输入**，2878 行是 tool_result
//
// 两条结论直接决定了下面每一行的写法：
//   1. **白名单 + 未知类型计数**。类型全集没有文档、会随版本加字段；
//      `if (type === 'user')` 这种写法迟早把 attachment 当成对话。
//   2. **过滤 tool_result 是能不能读得动的分水岭**（99.9% 的噪音在这）。
//
// 但 tool_result 同时是**证据的来源**：`toolUseResult` 的形状签名很稳
// （Edit 必带 filePath/oldString/newString/structuredPatch，Bash 必带
// stdout/stderr/interrupted）。所以卡片「证据」一节的文件:行号、命令原文、
// 报错首行是从这里**直接抽**的 —— 不经过模型，模型也就没机会编。

import { stat } from 'node:fs/promises'
import { redactText } from '../../core/redact.ts'
import { readHead, readLines } from '../../core/lines.ts'
import type { Evidence, Session, ToolCall, ToolResult, Turn } from '../../core/model.ts'
import { emptySession } from '../../core/model.ts'

// ---------------------------------------------------------------------------
// 行类型
// ---------------------------------------------------------------------------

/** 认识但故意不看的类型。列出来是为了把它们和「真·未知」分开计数。 */
const IGNORED = new Set([
  'attachment',
  'permission-mode',
  'mode',
  'last-prompt',
  'atis-latch',
  'ai-title',
  'file-history-delta',
  'file-history-snapshot',
  'queue-operation',
  'cost-state',
  'summary',
  'system',
])

interface RawBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

interface RawRow {
  type?: string
  uuid?: string
  parentUuid?: string | null
  timestamp?: string
  sessionId?: string
  cwd?: string
  gitBranch?: string
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  isVisibleInTranscriptOnly?: boolean
  origin?: { kind?: string }
  promptSource?: string
  message?: { role?: string; content?: string | RawBlock[] }
  toolUseResult?: unknown
}

// ---------------------------------------------------------------------------
// 文本处理
// ---------------------------------------------------------------------------

const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g
const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g

export function stripNoise(s: string): string {
  return s.replace(ANSI_RE, '').replace(REMINDER_RE, '')
}

/**
 * 斜杠命令的回显。
 *
 * 实测一场会话里 7 个「真人 turn」有 4 个是这类东西：
 *   <command-name>/goal</command-name><command-message>goal</command-message>
 *   <local-command-stdout>Goal set: …</local-command-stdout>
 * 它们是 CLI 自己打的，不是用户说的话，留在语料里会污染「用户纠正了 AI」
 * 这类信号的判定。
 *
 * 但 `<command-args>` 里装的是**用户自己敲的参数** —— 那个要留下，
 * 只把外壳剥掉。
 */
const FRAMEWORK_RE =
  /<(?:command-name|command-message|local-command-stdout|local-command-caveat)>[\s\S]*?<\/(?:command-name|command-message|local-command-stdout|local-command-caveat)>/g
const COMMAND_ARGS_RE = /<\/?command-args>/g

/** 用户中断的标记，不是话。 */
const INTERRUPT_RE = /^\[Request interrupted by user[^\]]*\]$/

function humanText(raw: string): string {
  const body = stripNoise(raw).replace(FRAMEWORK_RE, '').replace(COMMAND_ARGS_RE, '').trim()
  if (body === '' || INTERRUPT_RE.test(body)) return ''
  return body
}

export function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length <= n ? one : one.slice(0, n - 1) + '…'
}

/**
 * 从一段工具输出里挑出「代表这次失败」的那一行。
 *
 * 失败的 Bash 结果长这样：
 *     Error: Exit code 1
 *     sed: README.md: No such file or directory
 * 第一行是 CLI 自己套的壳，**每一类失败都一样**。直接拿它当签名，任何两次
 * Bash 失败都会撞成同一个签名，「同一错误复现 ≥2 次」这条信号就废了
 * （实测 44 次失败全塌成 `Error: Exit code #`）。
 *
 * 所以：跳过 CLI 壳，优先找带错误关键词的那一行，找不到才退而取第一行。
 */
export function pickErrorLine(text: string): string | null {
  const lines = stripNoise(text)
    .split('\n')
    .map(one => one.trim())
    .filter(one => one.length > 0)
  if (lines.length === 0) return null

  const rest = lines.filter(one => !/^Error: Exit code \d+$/i.test(one))
  if (rest.length === 0) return lines[0] ?? null

  // Python / JVM 的堆栈：头一行永远是 `Traceback (most recent call last):`，
  // 真正区分两次失败的异常在**最后一行**。不特判它的话，7 个不同的 Python
  // 报错会塌成同一个签名，「同一错误复现」就会误报。
  const last = rest[rest.length - 1]
  if (last !== undefined && /^[\w.]*(Error|Exception)\b[^\n]{0,120}$/.test(last)) return last

  const errish = rest.find(one =>
    /\b(error|exception|cannot|can't|no such|not found|failed|failure|denied|refused|traceback|unable|invalid|missing|undefined)\b/i.test(
      one,
    ),
  )
  return errish ?? rest[0] ?? lines[0] ?? null
}

/**
 * 报错签名 —— 把一次报错压成「同一类」的 key。
 *
 * 同一个 TS2307 在三次不同行号、不同文件上出现，必须是同一个签名，否则
 * 「同一错误复现 ≥2 次」这条信号永远不触发。所以要抹掉：数字、路径、
 * 引号里的具体名字、以及 ANSI 色码。
 */
export function errorSignature(text: string): string | null {
  const first = pickErrorLine(text)
  if (first === null) return null
  const sig = first
    .replace(/['"`]([^'"`]{0,120})['"`]/g, (_, inner: string) =>
      /[\\/]/.test(inner) ? '<path>' : '<name>',
    )
    // 注意：不能写 \b\d+ —— `TS2307` 里 `S` 和 `2` 之间没有单词边界，
    // 那样写会把错误码留下来，两次不同的错误码就被当成两类问题了。
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
  return clip(sig, 140)
}

// ---------------------------------------------------------------------------
// toolUseResult → Evidence / 成败
// ---------------------------------------------------------------------------

interface BashResult {
  stdout?: string
  stderr?: string
  interrupted?: boolean
  noOutputExpected?: boolean
  returnCodeInterpretation?: string
}

interface EditResult {
  filePath?: string
  oldString?: string
  newString?: string
  structuredPatch?: Array<{ oldStart?: number; oldLines?: number; newStart?: number; newLines?: number }>
}

interface WriteResult {
  type?: string
  file?: { filePath?: string; content?: string; numLines?: number; startLine?: number }
}

interface AgentResult {
  agentId?: string
  status?: string
  description?: string
  prompt?: string
  outputFile?: string
}

/** 工具名 → 它在会话里留下的证据。这是「证据白送」的实现。 */
function evidenceFor(name: string, input: Record<string, unknown>, raw: unknown): Evidence[] {
  const out: Evidence[] = []

  if (name === 'Bash' || name === 'BashOutput') {
    const cmd = input['command']
    if (typeof cmd === 'string') out.push({ kind: 'command', text: clip(cmd, 300) })
    const r = raw as BashResult | null
    if (r?.stderr?.trim()) out.push({ kind: 'output', text: clip(r.stderr.trim(), 300) })
    return out
  }

  if (name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') {
    const r = raw as EditResult | null
    const path = r?.filePath ?? (input['file_path'] as string | undefined)
    const hunk = r?.structuredPatch?.[0]
    if (typeof path === 'string') {
      out.push({ kind: 'file', text: hunk?.newStart ? `${path}:${hunk.newStart}` : path })
    }
    const after = r?.newString ?? (input['new_string'] as string | undefined)
    if (typeof after === 'string' && after.trim()) {
      out.push({ kind: 'patch', text: clip(after.trim(), 300) })
    }
    return out
  }

  if (name === 'Write') {
    const r = raw as WriteResult | null
    const path = r?.file?.filePath ?? (input['file_path'] as string | undefined)
    if (typeof path === 'string') out.push({ kind: 'file', text: path })
    return out
  }

  if (name === 'Read') {
    const r = raw as WriteResult | null
    const path = r?.file?.filePath ?? (input['file_path'] as string | undefined)
    if (typeof path === 'string') out.push({ kind: 'file', text: path })
    return out
  }

  if (name === 'Grep' || name === 'Glob') {
    const pat = input['pattern']
    if (typeof pat === 'string') out.push({ kind: 'command', text: `${name} ${clip(pat, 120)}` })
    return out
  }

  if (name === 'Agent' || name === 'Task') {
    const r = raw as AgentResult | null
    out.push({
      kind: 'agent',
      text: clip(r?.description ?? (input['description'] as string | undefined) ?? 'subagent', 160),
    })
    return out
  }

  const path = input['file_path'] ?? input['path']
  if (typeof path === 'string') out.push({ kind: 'file', text: path })
  return out
}

function resultOf(
  name: string,
  input: Record<string, unknown>,
  raw: unknown,
  isError: boolean,
): ToolResult {
  const evidence = evidenceFor(name, input, raw)
  if (!isError) return { ok: true, evidence }

  const r = raw as BashResult | null
  const head =
    (typeof r?.stderr === 'string' && r.stderr.trim() !== '' ? r.stderr : undefined) ??
    (typeof raw === 'string' ? raw : undefined) ??
    r?.returnCodeInterpretation ??
    '工具失败'
  const sig = errorSignature(head)

  // 失败时把「代表这一行」也塞进证据 —— 卡片的「证据」一节最需要的
  // 就是报错原文，而它此刻正好在手上。
  const line = pickErrorLine(head)
  if (line !== null && !evidence.some(e => e.text.includes(line.slice(0, 40)))) {
    evidence.push({ kind: 'output', text: clip(line, 300) })
  }

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

export interface ParseOptions {
  /** 只解析文件尾部这么多字节（hook 热路径）。省略即全量。 */
  tailBytes?: number
  /** 从第几行开始（state 的水位线）。行号 1-based。 */
  fromLine?: number
  /** 脱敏。默认开 —— 关掉只该出现在测试里。 */
  redact?: boolean
}

export async function parseClaudeSession(
  path: string,
  opts: ParseOptions = {},
): Promise<Session> {
  const { tailBytes, fromLine = 1, redact = true } = opts
  const st = await stat(path)
  const start = tailBytes === undefined ? 0 : Math.max(0, st.size - tailBytes)

  const header = await readHeader(path)
  const session = emptySession('claude-code', path, header.sessionId)
  session.size = st.size
  if (header.cwd !== undefined) session.cwd = header.cwd
  if (header.gitBranch !== undefined) session.gitBranch = header.gitBranch
  session.startedAt = header.startedAt

  const clean = (s: string): string => (redact ? redactText(s).text : s)

  /** 已发出、还没等到结果的工具调用。tool_result 靠 tool_use_id 回填。 */
  const pending = new Map<string, ToolCall>()
  let lastAssistant: Turn | null = null
  /** 见过的最大行号 —— 它就是下一次续读的水位线。 */
  let lastNo = 0

  for await (const { line, no } of readLines(path, { start, ...(tailBytes === undefined ? {} : { end: st.size - 1 }) })) {
    // tail 模式下 no 是未知的（从行中间开始的碎片），所以水位线只在全量时可信
    if (tailBytes === undefined && no < fromLine) continue
    if (tailBytes === undefined) lastNo = no
    if (line.trim() === '') continue

    let row: RawRow
    try {
      row = JSON.parse(line) as RawRow
    } catch {
      session.unknownTypes['__parse_error__'] = (session.unknownTypes['__parse_error__'] ?? 0) + 1
      continue
    }

    const type = row.type ?? '__no_type__'

    if (type === 'assistant') {
      const turn = readAssistant(row, clean)
      if (turn !== null) {
        for (const call of turn.toolCalls) pending.set(call.id, call)
        session.turns.push(turn)
        lastAssistant = turn
      } else if (lastAssistant !== null) {
        // 同一个 assistant 回合被拆到多行（apiBlockIndex 不同）—— 并回去
        mergeAssistant(lastAssistant, row, clean, pending)
      }
      continue
    }

    if (type === 'user') {
      // ① 工具回填
      const blocks = Array.isArray(row.message?.content) ? row.message.content : []
      const results = blocks.filter(b => b?.type === 'tool_result')
      if (results.length > 0) {
        for (const b of results) {
          const id = b.tool_use_id
          if (typeof id !== 'string') continue
          const call = pending.get(id)
          if (call === undefined) continue
          const raw = row.toolUseResult ?? extractResultText(b.content)
          call.result = resultOf(call.name, call.input, raw, b.is_error === true)
          pending.delete(id)
        }
        continue
      }

      // ② 真人输入
      const human = readHuman(row, clean)
      if (human !== null) session.turns.push(human)
      continue
    }

    if (IGNORED.has(type)) {
      session.unknownTypes[type] = (session.unknownTypes[type] ?? 0) + 1
      continue
    }
    session.unknownTypes[type] = (session.unknownTypes[type] ?? 0) + 1
  }

  session.lines = tailBytes === undefined ? lastNo : 0
  session.turns = session.turns.filter(t => t.text !== '' || t.toolCalls.length > 0)
  const last = session.turns[session.turns.length - 1]
  if (last?.ts !== undefined) session.endedAt = last.ts

  // 没等到结果的调用（会话被中断）不该丢掉证据
  for (const call of pending.values()) {
    if (call.result === null) call.result = { ok: true, evidence: evidenceFor(call.name, call.input, null) }
  }

  return session
}

/** 有些 tool_result 没有顶层 toolUseResult（44 行是纯字符串）。兜一下。 */
function extractResultText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts = content
      .map(b => (b as RawBlock)?.text)
      .filter((t): t is string => typeof t === 'string')
    return texts.length > 0 ? texts.join('\n') : null
  }
  return null
}

function readAssistant(row: RawRow, clean: (s: string) => string): Turn | null {
  const content = row.message?.content
  if (!Array.isArray(content)) return null

  const texts: string[] = []
  const thinks: string[] = []
  const calls: ToolCall[] = []

  for (const b of content) {
    if (b?.type === 'text' && typeof b.text === 'string') texts.push(clean(b.text))
    else if (b?.type === 'thinking' && typeof b.thinking === 'string') thinks.push(clean(b.thinking))
    else if (b?.type === 'tool_use' && typeof b.id === 'string') {
      calls.push({
        id: b.id,
        name: b.name ?? 'unknown',
        input: sanitizeInput(b.input ?? {}, clean),
        result: null,
      })
    }
  }

  if (texts.length === 0 && calls.length === 0 && thinks.length === 0) return null

  const turn: Turn = {
    role: 'assistant',
    text: texts.join('\n\n'),
    toolCalls: calls,
    isSidechain: row.isSidechain === true,
  }
  if (row.timestamp !== undefined) turn.ts = row.timestamp
  // thinking 体积巨大（实测 2819 个块），这里只留开头一段。
  // 真正的「按决策点截取」在 excerpt.ts 里按预算做。
  if (thinks.length > 0) turn.thinking = clip(thinks.join(' '), 1200)
  return turn
}

function mergeAssistant(
  turn: Turn,
  row: RawRow,
  clean: (s: string) => string,
  pending: Map<string, ToolCall>,
): void {
  const content = row.message?.content
  if (!Array.isArray(content)) return
  for (const b of content) {
    if (b?.type === 'text' && typeof b.text === 'string') {
      turn.text = turn.text === '' ? clean(b.text) : `${turn.text}\n\n${clean(b.text)}`
    } else if (b?.type === 'tool_use' && typeof b.id === 'string') {
      const call: ToolCall = {
        id: b.id,
        name: b.name ?? 'unknown',
        input: sanitizeInput(b.input ?? {}, clean),
        result: null,
      }
      turn.toolCalls.push(call)
      pending.set(call.id, call)
    }
  }
}

/**
 * 真人输入。
 *
 * 15210/15641 的 user 行没有 origin，所以不能靠它判定。实测可用的四条：
 *   toolUseResult == null（不是工具回填）
 *   !isMeta && !isCompactSummary（不是系统注入 / 压缩摘要）
 *   content 里有 text 块（或直接是字符串）
 *   stripNoise 之后正文非空（纯 <system-reminder> 行要丢掉）
 * promptSource==='system' 之外的（typed / suggestion_accepted / 缺省）都算人。
 */
function readHuman(row: RawRow, clean: (s: string) => string): Turn | null {
  if (row.toolUseResult !== undefined && row.toolUseResult !== null) return null
  if (row.isMeta === true) return null
  if (row.isCompactSummary === true) return null
  if (row.promptSource === 'system') return null
  const kind = row.origin?.kind
  if (kind === 'task-notification' || kind === 'peer') return null

  const content = row.message?.content
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = content
      .filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b.text as string)
      .join('\n')
  }

  const body = humanText(text)
  if (body === '') return null

  const turn: Turn = { role: 'human', text: clean(body), toolCalls: [], isSidechain: row.isSidechain === true }
  if (row.timestamp !== undefined) turn.ts = row.timestamp
  return turn
}

/** 工具入参也要脱敏 —— 密钥经常是被写进文件或命令行的那一方。 */
function sanitizeInput(input: Record<string, unknown>, clean: (s: string) => string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = v.length > 4000 ? clean(v.slice(0, 4000)) : clean(v)
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v
    else if (Array.isArray(v)) out[k] = v.slice(0, 20)
    else if (typeof v === 'object') out[k] = clip(JSON.stringify(v), 600)
  }
  return out
}

interface Header {
  sessionId: string
  cwd?: string
  gitBranch?: string
  startedAt?: string
}

/** 头部信息（cwd/gitBranch/起始时间）取文件开头几行就够，不必扫全文件。 */
async function readHeader(path: string): Promise<Header> {
  const head = readHead(path)
  const out: Header = { sessionId: basenameNoExt(path) }
  for (const line of head.split('\n').slice(0, 40)) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line) as RawRow
      if (out.cwd === undefined && typeof row.cwd === 'string') out.cwd = row.cwd
      if (out.gitBranch === undefined && typeof row.gitBranch === 'string') out.gitBranch = row.gitBranch
      if (out.startedAt === undefined && typeof row.timestamp === 'string') out.startedAt = row.timestamp
      if (typeof row.sessionId === 'string') out.sessionId = row.sessionId
    } catch {
      /* 头部有个别坏行不影响 */
    }
  }
  return out
}

function basenameNoExt(p: string): string {
  const base = p.slice(p.lastIndexOf('/') + 1)
  return base.endsWith('.jsonl') ? base.slice(0, -6) : base
}

// ---------------------------------------------------------------------------
// 会话查找
// ---------------------------------------------------------------------------

/** cwd → `~/.claude/projects/<slug>` 的 slug 规则：把 `/` 和 `.` 换成 `-`。 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}
