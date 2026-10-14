// 用本机的 `codex exec` 当脑子 —— 给「Claude Code 之外也想用同一套脑子」的人。
//
// 比 claude 脑多两个坑，都在参数里处理掉了：
//
//   1. `--ephemeral`：否则每次蒸馏都会往 `~/.codex/sessions/YYYY/MM/DD/` 里
//      写一份 rollout 文件。而我们自己的 codex 适配器（里程碑 2）正是去读那个
//      目录的 —— 于是蒸馏的产物会被当成「一场真实会话」再蒸馏一遍，无限套娃。
//   2. `--skip-git-repo-check` + `-C <知识库>`：知识库不是 git 仓库，
//      而 codex 默认要求工作目录在仓库里。
//
// **不能用 `--ignore-user-config`**：那会丢掉 `[model_providers.custom]`，
// codex 就不知道往哪个端点发了。

import { spawn } from 'node:child_process'
import { buildPrompt, reconcile } from './prompt.ts'
import { clip, extractJson } from './json.ts'
import { sentinelEnv, type Brain, type BrainOptions, type BrainResult, type DistillInput } from './types.ts'

export const codexBrain: Brain = {
  name: 'codex',

  async probe(): Promise<{ ok: boolean; detail: string }> {
    return new Promise(resolve => {
      const child = spawn('codex', ['--version'], { env: sentinelEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString('utf8')
      })
      child.on('error', () => resolve({ ok: false, detail: 'PATH 里找不到 codex' }))
      child.on('close', code =>
        resolve(
          code === 0
            ? { ok: true, detail: `codex ${out.trim()}` }
            : { ok: false, detail: `codex --version 退出码 ${String(code)}` },
        ),
      )
    })
  },

  async distill(input: DistillInput, opts: BrainOptions): Promise<BrainResult> {
    const base: BrainResult = { brain: 'codex', drafts: [] }
    const started = Date.now()

    const args = [
      'exec',
      '-C', opts.cwd,
      '--skip-git-repo-check',
      '--ephemeral', // ★ 不落 session 文件，否则会被自己的适配器当成真实会话
      '-s', 'read-only', // 蒸馏不需要写任何东西
      ...(opts.model === undefined ? [] : ['-m', opts.model]),
      '-', // 提示词从 stdin 读
    ]

    const res = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>(
      resolve => {
        const child = spawn('codex', args, {
          cwd: opts.cwd,
          env: sentinelEnv(),
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        let timedOut = false
        const CAP = 4 * 1024 * 1024

        child.stdout.on('data', (d: Buffer) => {
          if (stdout.length < CAP) stdout += d.toString('utf8')
        })
        child.stderr.on('data', (d: Buffer) => {
          if (stderr.length < 64 * 1024) stderr += d.toString('utf8')
        })
        const timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, opts.timeoutMs)
        child.on('error', err => {
          clearTimeout(timer)
          resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut })
        })
        child.on('close', code => {
          clearTimeout(timer)
          resolve({ code, stdout, stderr, timedOut })
        })
        child.stdin.on('error', () => {})
        child.stdin.end(buildPrompt(input), 'utf8')
      },
    )

    const ms = Date.now() - started
    if (res.timedOut) return { ...base, degraded: `codex 超时(${opts.timeoutMs}ms),已降级为骨架卡` }
    if (res.code !== 0) {
      return { ...base, degraded: `codex 退出码 ${String(res.code)}: ${clip(res.stderr.trim(), 200)}` }
    }

    const raw = extractJson(res.stdout)
    if (raw === null) {
      return { ...base, degraded: `codex 输出里没有可解析的 JSON: ${clip(res.stdout, 200)}` }
    }

    const { drafts, dropped } = reconcile(raw, input.candidates)
    if (drafts.length === 0) {
      return { ...base, degraded: `返回的条目一条都对不上候选表(${dropped.slice(0, 3).join('; ')})` }
    }
    return {
      ...base,
      drafts,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, ms },
      ...(dropped.length === 0 ? {} : { degraded: `有 ${dropped.length} 条没补上: ${dropped.slice(0, 3).join('; ')}` }),
    }
  },
}
