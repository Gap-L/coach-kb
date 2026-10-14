// 找会话文件。
//
// Claude Code 的会话落在 `~/.claude/projects/<slug>/<sessionId>.jsonl`，
// slug 是 cwd 把 `/` 和 `.` 换成 `-` 得到的（见 adapters 里的 projectSlug）。
//
// ★ 反解 slug 是**不可靠的**：`/a/b` 和 `/a-b` 会得到同一个 slug。
// 所以这里的 cwd 一律从 jsonl 的头部读，不从目录名猜。目录名只用来分组。

import { readdirSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { readHead } from './lines.ts'

export interface FoundSession {
  path: string
  sessionId: string
  /** 从文件头读出来的真实 cwd。读不到就是空串。 */
  cwd: string
  mtimeMs: number
  size: number
}

export function projectsRoot(): string {
  return process.env['COACH_PROJECTS_ROOT'] ?? join(homedir(), '.claude', 'projects')
}

/**
 * 读 jsonl 头几行，把 cwd 抠出来。
 *
 * 只读开头那一段 —— 见 `lines.ts:readHead` 里那段说明（这里原来也在
 * 整文件读，52MB 的会话上 `--latest` 因此慢了一个数量级）。
 */
export function readCwd(path: string): string {
  for (const line of readHead(path).split('\n').slice(0, 200)) {
    if (!line.includes('"cwd"')) continue
    try {
      const row = JSON.parse(line) as { cwd?: unknown }
      if (typeof row.cwd === 'string' && row.cwd !== '') return row.cwd
    } catch {
      /* 头部的半行，忽略 */
    }
  }
  return ''
}

export function findClaudeSessions(root = projectsRoot()): FoundSession[] {
  if (!existsSync(root)) return []
  const out: FoundSession[] = []
  for (const dir of readdirSync(root)) {
    const full = join(root, dir)
    let entries: string[]
    try {
      if (!statSync(full).isDirectory()) continue
      entries = readdirSync(full)
    } catch {
      continue
    }
    for (const file of entries) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(full, file)
      try {
        const st = statSync(path)
        if (!st.isFile() || st.size === 0) continue
        out.push({
          path,
          sessionId: file.replace(/\.jsonl$/, ''),
          cwd: '',
          mtimeMs: st.mtimeMs,
          size: st.size,
        })
      } catch {
        /* 竞态：正在被删 */
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * 当前目录属不属于这个会话的工作目录。
 *
 * **不能用 `===`。** 实测踩到的正是这个:Claude Code 记录的是会话**启动时**的
 * cwd,而人是会 `cd` 的 —— 从 `/repo` 启动、`cd src/deep` 之后敲
 * `/coach-kb:review`,精确比较会一个都匹配不上,于是静默退回「全局最新会话」,
 * 而那多半是隔壁项目的。表现是:同一台机器上连着跑两次,复盘的是两场不同的会话。
 *
 * 所以判据是**目录包含**:当前目录在会话的工作目录之下(或就是它)。
 */
function sameProject(sessionCwd: string, here: string): boolean {
  if (sessionCwd === '') return false
  if (sessionCwd === here) return true
  return here.startsWith(sessionCwd.endsWith('/') ? sessionCwd : sessionCwd + '/')
}

/**
 * 定下要处理哪一个会话。
 *
 * `--latest` 的语义是「我刚刚在用的那个」—— 所以**优先当前目录对应的会话**，
 * 而不是全局最新的那个。你在 A 项目里敲 `/coach-kb:review`，
 * 想复盘的显然是 A 的会话，不是隔壁 B 项目五分钟前刚结束的那个。
 */
export function resolveSession(
  flag: string | undefined,
  opts: { cwd?: string; sessions?: FoundSession[]; readCwd?: (path: string) => string } = {},
): { session: FoundSession | null; how: string } {
  const sessions = opts.sessions ?? findClaudeSessions()
  if (sessions.length === 0) return { session: null, how: '一个会话文件都没找到' }

  if (flag !== undefined && flag !== 'latest' && flag !== '') {
    // ★ 先当**路径**试。`--session` 的文档说的是「路径或 id」，那就必须真的
    //   接受任意路径 —— 包括复制出来的会话副本和测试夹具。原来只认
    //   「扫描目录扫到的那些」，于是锁不进任何 fixture，也没法把会话冻结下来
    //   验证幂等（正在写的会话每跑一次输入都不一样，那不是幂等测试）。
    for (const candidate of [flag, join(process.cwd(), flag)]) {
      try {
        const st = statSync(candidate)
        if (!st.isFile()) continue
        return {
          session: {
            path: resolve(candidate),
            sessionId: basename(candidate).replace(/\.(jsonl|json)$/, ''),
            cwd: '',
            mtimeMs: st.mtimeMs,
            size: st.size,
          },
          how: '--session 指定的路径',
        }
      } catch {
        /* 不是路径，往下试 id */
      }
    }

    const byPath = sessions.find(s => s.path === flag)
    if (byPath !== undefined) return { session: byPath, how: '--session 指定的路径' }
    // 也允许只给 sessionId 前缀
    const byId = sessions.filter(s => s.sessionId.startsWith(flag))
    if (byId.length === 1) return { session: byId[0] as FoundSession, how: '--session 指定的 id' }
    if (byId.length > 1) return { session: null, how: `id 前缀 ${flag} 对上多个会话,请写全` }
    return { session: null, how: `找不到会话 ${flag}` }
  }

  const here = opts.cwd ?? process.cwd()
  // 读 cwd 的方式随宿主不同(Codex 的 cwd 藏在 session_meta.payload 里),由调用方给
  const cwdOf = opts.readCwd ?? readCwd
  const withCwd = sessions.map(s => ({ ...s, cwd: s.cwd === '' ? cwdOf(s.path) : s.cwd }))
  const local = withCwd.filter(s => sameProject(s.cwd, here))
  if (local.length > 0) {
    // 说清楚挑的是哪一场、以及竞争者有谁 —— 挑错了要能一眼看出来。
    const first = local[0] as FoundSession
    const how = `当前目录(${first.cwd})最新的会话${local.length > 1 ? `,该目录另有 ${local.length - 1} 场更早的` : ''}`
    return { session: first, how }
  }
  return { session: withCwd[0] as FoundSession, how: '⚠ 当前目录没有会话,退到全局最新的一场(可能要加 --session 指定)' }
}

/** 给 `--list` 用的简短显示。 */
export function describeSession(s: FoundSession): string {
  const mb = (s.size / 1048576).toFixed(1)
  const when = new Date(s.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')
  return `${s.sessionId.slice(0, 8)}  ${when}  ${mb.padStart(6)}MB  ${s.cwd === '' ? '(未知目录)' : s.cwd}`
}
