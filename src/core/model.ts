// 统一中间表示（IR）。
//
// 三个宿主的会话格式毫无关系，但沉淀层只关心同样几件事：谁说了什么、AI 动了
// 哪些文件、什么报错、用户在哪一句上纠正了它。解析器的全部工作就是把私有格式
// 压成下面这几个类型。
//
// **IR 是唯一会被送出去的东西**（送进 brain 蒸馏）。所以脱敏的边界就在
// `toIR` 这一步：进得来 IR 的内容必然已经过 `redact.ts`。

export type Host = 'claude-code' | 'codex' | 'workbuddy'

/** 工具结果里被抓住的一行原文，卡片「证据」一节的来源。 */
export interface Evidence {
  kind: 'file' | 'command' | 'output' | 'patch' | 'agent'
  /** 人可读的一行。文件带 :行号，命令带原文，报错带首行。 */
  text: string
}

export interface ToolResult {
  ok: boolean
  /** 失败时的归一化签名（错误类名 + 首行，去掉行号/路径里的数字）。 */
  errorSig?: string
  /** 失败时的首行原文，用来给人看。 */
  errorHead?: string
  evidence: Evidence[]
}

export interface ToolCall {
  id: string
  name: string
  /** 工具入参。已脱敏、已裁剪。 */
  input: Record<string, unknown>
  result: ToolResult | null
}

/** 一个真人回合，以及它触发的那串工具调用。 */
export interface Turn {
  /** 真人输入原文（逐字，不改写）。assistant 轮为空串。 */
  text: string
  role: 'human' | 'assistant'
  ts?: string
  /** assistant 轮才有的工具调用。 */
  toolCalls: ToolCall[]
  /** 被预算裁过的 thinking 片段，只留决策点附近。 */
  thinking?: string
  /** 子代理（Agent 工具派生的 sidechain）—— 不入主线索。 */
  isSidechain: boolean
}

export interface Session {
  host: Host
  sessionId: string
  /** 解析来源的绝对路径。 */
  path: string
  cwd: string
  gitBranch?: string
  startedAt?: string
  endedAt?: string
  turns: Turn[]
  /** 未知行类型的计数。上报而不报错 —— 宿主加字段不该让解析器炸。 */
  unknownTypes: Record<string, number>
  /** 源文件的字节数与行数，state 的水位线靠它。 */
  size: number
  lines: number
  warnings: string[]
}

/** IR 里的一个「信号」——由 signals.ts 从 Session 里挑出来的候选。 */
export interface Signal {
  kind: string
  /** 0..1，阈值在 config 里。 */
  confidence: number
  /** 这一条信号指向会话里的第几个 turn。 */
  turnIndex: number
  /** 一句话说明为什么挑中它（会写进卡片 frontmatter）。 */
  why: string
  /** 相关证据，直接从 IR 里搬，不重新生成。 */
  evidence: Evidence[]
  /** 用户的原话（如果这条信号本来就来自用户说的话）。 */
  userWords?: string
}

export const emptySession = (host: Host, path: string, sessionId: string): Session => ({
  host,
  sessionId,
  path,
  cwd: '',
  turns: [],
  unknownTypes: {},
  size: 0,
  lines: 0,
  warnings: [],
})
