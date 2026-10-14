// 找 Codex 会话文件:`~/.codex/sessions/YYYY/MM/DD/rollout-<时间>-<uuid>.jsonl`。
//
// 与 Claude Code 不同,目录按**日期**而不是按项目分组,所以「当前目录的会话」
// 只能读每个文件头里的 cwd 来判断(见 parse.ts 的 readCodexHeader)。

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { FoundSession } from '../../core/sessions.ts'
import { readCodexHeader } from './parse.ts'

export function codexSessionsRoot(): string {
  return process.env['COACH_CODEX_SESSIONS'] ?? join(homedir(), '.codex', 'sessions')
}

/** 递归收 rollout-*.jsonl。深度固定是 3(年/月/日),多给一层余量。 */
export function findCodexSessions(root = codexSessionsRoot()): FoundSession[] {
  if (!existsSync(root)) return []
  const out: FoundSession[] = []
  const walk = (dir: string, depth: number): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (depth < 4) walk(full, depth + 1)
        continue
      }
      if (!st.isFile() || st.size === 0 || !name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
      out.push({ path: full, sessionId: idFromName(name), cwd: '', mtimeMs: st.mtimeMs, size: st.size })
    }
  }
  walk(root, 0)
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** 文件名末尾就是 uuid —— 扫描阶段不必打开文件。 */
function idFromName(name: string): string {
  return name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/)?.[1] ?? name.replace(/\.jsonl$/, '')
}

export function readCodexCwd(path: string): string {
  return readCodexHeader(path).cwd ?? ''
}
