// 知识库落在哪。
//
// 默认 ~/knowledge —— 它**不属于任何代码仓**，因为它记的是「你会什么」，
// 不是「这个项目怎么跑」。项目相关的那部分知识，出口是回写进项目的
// CLAUDE.md / AGENTS.md（见 commands/rule.ts）。

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

export const DEFAULT_KB = join(homedir(), 'knowledge')

export function resolveKb(flag?: string): string {
  const raw = flag ?? process.env['COACH_KB'] ?? DEFAULT_KB
  return resolve(raw.replace(/^~(?=\/|$)/, homedir()))
}

export interface KbPaths {
  root: string
  index: string
  cards: string
  concepts: string
  patterns: string
  pitfalls: string
  playbooks: string
  inbox: string
  digests: string
  meta: string
  state: string
  config: string
  logs: string
  /** hook 读的旧卡检索表。由 writeIndex 生成，别手改。 */
  recall: string
}

export function kbPaths(root: string): KbPaths {
  const cards = join(root, 'cards')
  const meta = join(root, '.coach')
  return {
    root,
    index: join(root, 'index.md'),
    cards,
    concepts: join(cards, 'concepts'),
    patterns: join(cards, 'patterns'),
    pitfalls: join(cards, 'pitfalls'),
    playbooks: join(cards, 'playbooks'),
    inbox: join(root, 'inbox'),
    digests: join(root, 'digests'),
    meta,
    state: join(meta, 'state.json'),
    config: join(meta, 'config.json'),
    logs: join(meta, 'logs'),
    recall: join(meta, 'recall.json'),
  }
}

export function typeDir(p: KbPaths, type: string): string {
  switch (type) {
    case 'concept':
      return p.concepts
    case 'pattern':
      return p.patterns
    case 'playbook':
      return p.playbooks
    default:
      return p.pitfalls
  }
}

/** 建齐目录。知识库是**用户自己的**，权限给 0700。 */
export function ensureKb(root: string): KbPaths {
  const p = kbPaths(root)
  for (const dir of [p.root, p.cards, p.concepts, p.patterns, p.pitfalls, p.playbooks, p.inbox, p.digests, p.meta, p.logs]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  return p
}
