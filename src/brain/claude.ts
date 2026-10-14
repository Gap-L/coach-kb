// 用本机的 `claude` headless 当脑子。
//
// 选它的理由：零 key 管理，复用已有的订阅与端点配置。代价是**固定开销很大**：
// 一次调用的 input tokens 里九成是 agentic 运行时自己的系统提示与工具 schema。
//
// 下面这组参数是**本机实测**出来的，不是猜的（`coach brain bench` 会复现）：
//
//   | 参数                                            | input tokens | 成本     |
//   | 无参数                                           | 45,235       | $0.2262  |
//   | --strict-mcp-config --settings '{}' --max-turns 1| 20,857       | $0.1043  |
//   | ＋ --setting-sources ''                          | 20,334       | $0.1017  |
//   | ＋ --disallowedTools …                           | 16,951       | $0.0848  |
//
// 计划里原本判断「关技能省钱是白费力气」，实测**不对**：降了 62%。大头不是
// 插件和技能，是 `~/.codex/config.toml` 里那三个 MCP server 的工具 schema。
// 所以 --strict-mcp-config 是这几行里最值钱的一个。
//
// 蒸馏是**非 agentic 任务** —— 它不需要读文件、不需要跑命令。所以禁掉工具
// 不但省钱，还顺带堵死了一条风险：模型拿着 Bash 去「自己找证据」，
// 找回来的东西就没人保证它是真的了。

import { spawn } from 'node:child_process'
import { buildPrompt, reconcile } from './prompt.ts'
import { clip, extractJson, readResultPayload } from './json.ts'
import { sentinelEnv, type Brain, type BrainOptions, type BrainResult, type DistillInput } from './types.ts'

/**
 * 禁掉全部工具。
 *
 * 这串名字若与某个版本的 CLI 对不上，调用可能直接失败 —— 所以调用方在
 * 拿到非零退出时会**去掉这一组重试一次**（见 distill）。宁可多花两分钱，
 * 不能让一个工具名把整条链打死。
 */
const DISALLOWED = [
  'Bash', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'KillShell', 'BashOutput', 'SlashCommand',
]

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

function runClaude(prompt: string, opts: BrainOptions, extra: string[]): Promise<RunResult> {
  return new Promise(resolve => {
    const args = [
      '-p',
      '--output-format', 'json',
      '--strict-mcp-config',
      '--settings', '{}',
      '--setting-sources', '',
      '--max-turns', '1',
      ...(opts.model === undefined ? [] : ['--model', opts.model]),
      ...extra,
    ]

    const child = spawn('claude', args, {
      cwd: opts.cwd, // ★ 知识库目录，不是项目目录 —— 免得加载项目的 CLAUDE.md
      env: sentinelEnv(), // ★ 哨兵：我们调起的会话不会再触发我们自己的 hook
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    // 输出可能有几十 KB，但也不能无限攒 —— 攒爆内存比截断更糟。
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

    child.stdin.on('error', () => {
      /* 子进程提前死了，写 stdin 会 EPIPE —— 下面 close 里会给出结论 */
    })
    child.stdin.end(prompt, 'utf8')
  })
}

export const claudeBrain: Brain = {
  name: 'claude',

  async probe(): Promise<{ ok: boolean; detail: string }> {
    return new Promise(resolve => {
      const child = spawn('claude', ['--version'], { env: sentinelEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString('utf8')
      })
      child.on('error', () => resolve({ ok: false, detail: 'PATH 里找不到 claude' }))
      child.on('close', code =>
        resolve(
          code === 0
            ? { ok: true, detail: `claude ${out.trim()}` }
            : { ok: false, detail: `claude --version 退出码 ${String(code)}` },
        ),
      )
    })
  },

  async distill(input: DistillInput, opts: BrainOptions): Promise<BrainResult> {
    const base: BrainResult = { brain: 'claude', drafts: [] }
    const prompt = buildPrompt(input)
    const started = Date.now()

    // 第一次带禁用工具列表；失败了去掉重试 —— 不为了省钱把整条链打死。
    let res = await runClaude(prompt, opts, ['--disallowedTools', ...DISALLOWED])
    if (res.code !== 0 && !res.timedOut) {
      res = await runClaude(prompt, opts, [])
    }

    const ms = Date.now() - started
    const err = res.stderr.trim()

    if (res.timedOut) {
      return { ...base, degraded: `claude 超时(${opts.timeoutMs}ms),已降级为骨架卡` }
    }
    if (res.code !== 0) {
      return { ...base, degraded: `claude 退出码 ${String(res.code)}: ${clip(err, 200)}` }
    }

    const payload = readResultPayload(res.stdout)
    if (payload === null) {
      return { ...base, degraded: `claude 输出里没有结果对象(可它退出码是 0): ${clip(res.stdout, 200)}` }
    }
    if (payload.isError) {
      return { ...base, degraded: `claude 报告出错: ${clip(payload.text === '' ? err : payload.text, 200)}` }
    }

    const raw = extractJson(payload.text)
    if (raw === null) {
      return {
        ...base,
        degraded: `模型没返回可解析的 JSON: ${clip(payload.text, 200)}`,
      }
    }

    const { drafts, dropped } = reconcile(raw, input.candidates)
    const usage = payload.usage === undefined ? undefined : { ...payload.usage, ms }

    if (drafts.length === 0) {
      return {
        ...base,
        ...(usage === undefined ? {} : { usage }),
        degraded: `返回的条目一条都对不上候选表(${dropped.slice(0, 3).join('; ')})`,
      }
    }

    return {
      brain: 'claude',
      drafts,
      ...(usage === undefined ? {} : { usage }),
      // 部分对上也算退化，但不丢已对上的 —— 用户会看到「有几条没补上」
      ...(dropped.length === 0 ? {} : { degraded: `有 ${dropped.length} 条没补上: ${dropped.slice(0, 3).join('; ')}` }),
    }
  },
}
