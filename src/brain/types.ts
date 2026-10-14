// 脑子（brain）—— 谁负责把半成品卡补成完整卡。
//
// 设计约束来自实测：`claude -p` 一次调用的固定开销是 45k input tokens /
// $0.226，其中九成是 agentic 运行时自身的系统提示与工具 schema，砍不掉
// （见 docs/privacy.md 的实测表）。于是两条铁律：
//
//   1. **批量化**：一次调用处理一整场会话的全部候选，绝不「一卡一次调用」。
//      固定开销既然已经付了，就应该让它在这一次里多干活。
//   2. **只补两件事**：标题、type、tags、证据都由 CLI 从会话里直接抽好了
//      （证据是白送的，见 adapters/claude-code/parse.ts 的形状签名）。
//      AI 只负责「为什么会这样」和「可迁移到哪」——
//      这样它既没有机会编造证据，输出也短，便宜且不易跑偏。
//
// 所有脑子必须实现同一个接口，且**任何一个失败都必须能退化成 none**：
// 宁可产出没有 AI 补充的骨架卡，也不能因为模型挂了就丢掉这次会话的候选。

import type { CardType } from '../core/ids.ts'

/** 给 AI 的一条候选。证据已由 CLI 填好，AI 不许改。 */
export interface Candidate {
  index: number
  title: string
  type: CardType
  /** 挑中它的那条信号的类型（repeat_error / repeat_edit / …），进卡片 frontmatter。 */
  kind: string
  why: string
  evidence: string[]
  /** 用户当时说的话（如果有）—— AI 补的「为什么」应当与它呼应，而不是另起一套 */
  userWords?: string
  /**
   * 这条候选落在会话的第几轮。
   *
   * 只给 CLI 用（决定挑哪一段原文当上下文），**不进提示词** —— 让模型看到
   * 「第 137 轮」这种数字，它会忍不住在解释里引用它，而那个数字对用户毫无意义。
   */
  turnIndex?: number
}

export interface DistillInput {
  /** 会话头信息（工具/目录/分支），不含对话内容 */
  header: string
  /** 证据摘要，由 core/excerpt.ts 裁到预算内 */
  excerpt: string
  candidates: Candidate[]
}

/** AI 补出来的东西。只有这两个字段是它说了算的。 */
export interface Draft {
  index: number
  /** 「为什么会这样」 */
  ai: string
  /** 「下次这类问题的第一步」 */
  transfer: string
  tags?: string[]
  confidence?: number
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  costUsd: number
  ms: number
}

export interface BrainResult {
  drafts: Draft[]
  usage?: Usage
  brain: string
  /**
   * 非空表示这次退化了（超时/非 JSON/模型不可用）。
   * **必须一路传到输出里**，绝不静默 —— 静默失败正是旧 coach 的病根。
   */
  degraded?: string
}

export interface BrainOptions {
  timeoutMs: number
  model?: string
  /** 今天的剩余预算（美元）。超了就不调，直接退化。 */
  budgetUsd?: number
  /** 子进程的工作目录。**要设成知识库目录**，别让它读项目的 CLAUDE.md。 */
  cwd: string
}

export interface Brain {
  readonly name: string
  /** 这台机器上能不能用 */
  probe(): Promise<{ ok: boolean; detail: string }>
  distill(input: DistillInput, opts: BrainOptions): Promise<BrainResult>
}

/** 调 headless CLI 时打的哨兵，防止我们调起的会话又被自己的 hook 触发。 */
export const BRAIN_SENTINEL = 'COACH_BRAIN_CALL'

export function sentinelEnv(): NodeJS.ProcessEnv {
  return { ...process.env, [BRAIN_SENTINEL]: '1' }
}

/** 我们正跑在自己调起的会话里吗？hook 的第一行就查这个。 */
export function insideBrainCall(): boolean {
  return process.env[BRAIN_SENTINEL] === '1'
}
