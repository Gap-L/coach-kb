// 把 plugin/skills/* 改写成 Codex / WorkBuddy / Cursor 能用的 skill。
//
// 三个宿主的 skill 形状一样(`<name>/SKILL.md` + name/description frontmatter),
// 差别只有三处,全在这里处理:
//   1. 没有 ${CLAUDE_PLUGIN_ROOT} —— 换成 coach.mjs 的**绝对路径**
//   2. 不认 `allowed-tools` / `user-invocable` —— 删掉,免得那边报未知字段
//   3. 名字不带插件命名空间 —— `review` 太容易撞名(~/.codex/skills 里常有别人的
//      review),统一加 `coach-kb-` 前缀
//
// renderHostSkill 是纯函数,不碰文件系统。装机逻辑在 install.ts。

import { homedir } from 'node:os'
import { join } from 'node:path'

export type SkillHost = 'codex' | 'workbuddy' | 'cursor'

export const PREFIX = 'coach-kb-'

/** 装进去的每个目录里放这个文件 —— 卸载时只删带它的,别人的 skill 碰都不碰。 */
export const MARKER = '.coach-kb'

/** 每个宿主装哪些 skill,以及从哪拿模板。 */
export interface SkillPlanItem {
  name: string
  from: 'plugin' | 'host'
  /** from=host 时模板在 plugin/hosts/<hostDir>/ 下。缺省就是宿主名。 */
  hostDir?: string
}

export function skillPlan(host: SkillHost): SkillPlanItem[] {
  // 这三个宿主都没有 Claude Code 那条 UserPromptSubmit hook,
  // 「提到记过的知识点就先复述」只能靠一个 skill 让那边的 AI 自己去查 —— 见 hosts/common/recall。
  const recall: SkillPlanItem = { name: 'recall', from: 'host', hostDir: 'common' }
  if (host === 'codex') {
    return [...['review', 'coach', 'save', 'kb', 'due'].map(name => ({ name, from: 'plugin' as const })), recall]
  }
  // WorkBuddy / Cursor 读不到会话,review 换成自报版的 report(模板共用 workbuddy 那份)
  return [
    { name: 'report', from: 'host', hostDir: 'workbuddy' },
    recall,
    { name: 'coach', from: 'plugin' },
    { name: 'save', from: 'plugin' },
    { name: 'kb', from: 'plugin' },
    { name: 'due', from: 'plugin' },
  ]
}

const HOST_NAME: Record<SkillHost, string> = { codex: 'Codex', workbuddy: 'WorkBuddy', cursor: 'Cursor' }

function shellPath(p: string): string {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : JSON.stringify(p)
}

export function renderHostSkill(md: string, opts: { host: SkillHost; coach: string }): string {
  const coach = shellPath(opts.coach)
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/)
  const fm = m?.[1] ?? ''
  let body = m === null || m === undefined ? md : md.slice(m[0].length)

  // ---- frontmatter:只留 name / description ---------------------------------
  const keep: string[] = []
  let skipping = false
  for (const line of fm.split('\n')) {
    if (/^\s/.test(line) || line.trim() === '') {
      if (!skipping) keep.push(line)
      continue
    }
    const key = line.slice(0, line.indexOf(':')).trim()
    skipping = key !== 'name' && key !== 'description'
    if (skipping) continue
    keep.push(key === 'name' ? `name: ${PREFIX}${line.slice(line.indexOf(':') + 1).trim()}` : line)
  }

  // ---- 正文 -----------------------------------------------------------------
  body = body
    .replaceAll('node ${CLAUDE_PLUGIN_ROOT}/dist/coach.mjs', `node ${coach}`)
    .replaceAll('${CLAUDE_PLUGIN_ROOT}/dist/coach.mjs', coach)
    .replaceAll('{{COACH}}', coach)
    // 互相引用的 skill 名跟着加前缀
    .replace(/`(review|coach|save|kb|due|report|recall)` skill/g, `\`${PREFIX}$1\` skill`)

  if (opts.host === 'codex') {
    // Codex 的会话要显式 --host,否则读到的是 Claude Code 的会话
    // 只改紧跟在 coach 路径后面的那个动词 —— 正文里散落的 review 字样不该动
    body = body.replaceAll(`${coach} review`, `${coach} review --host codex`).replaceAll(`${coach} distill`, `${coach} distill --host codex`)
  }

  if (opts.host === 'cursor') {
    // report 模板是给 WorkBuddy 写的;卡片来源要记成 cursor,文案里的宿主名也跟着换
    body = body.replaceAll('--host workbuddy', '--host cursor').replaceAll('WorkBuddy', HOST_NAME.cursor)
    for (let i = 0; i < keep.length; i++) keep[i] = (keep[i] as string).replaceAll('WorkBuddy', HOST_NAME.cursor)
  }

  const note = `<!-- 由 coach install --${opts.host} 生成,勿手改;卸载:coach install --${opts.host} --uninstall --yes -->\n`
  return `---\n${keep.join('\n')}\n---\n${note}${body}`
}

/** 各宿主的 skill 目录。环境变量是给测试用的,别让测试写进真的 home。 */
export function skillsRoot(host: SkillHost): string {
  if (host === 'codex') return process.env['COACH_CODEX_SKILLS'] ?? join(homedir(), '.codex', 'skills')
  if (host === 'cursor') return process.env['COACH_CURSOR_SKILLS'] ?? join(homedir(), '.cursor', 'skills')
  return process.env['COACH_WORKBUDDY_SKILLS'] ?? join(homedir(), '.workbuddy', 'skills')
}

