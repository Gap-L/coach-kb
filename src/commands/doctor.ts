// `coach doctor` —— 把「装了但没生效」照出来。
//
// 它存在的理由很具体:这个项目的失败模式**几乎全是静默的**。
//   · hook 没装成        → 表现是「再也不提醒了」,和「这周确实没什么可提醒的」一模一样
//   · 插件从 git 装      → ${CLAUDE_PLUGIN_ROOT} 指向缓存副本,`../dist` 读不到,bundle 缺失
//   · 源码改了没重新 build → 插件里跑的仍是旧代码,而 hook 那边无声无息
//   · 新旧两份协议同时注入 → 模型收到两套指令,用户看到两条同样开头的话
// 没有一条会报错。
//
// 所以退出码只表示「有没有真问题」:✗ → 1,⚠ 与 ✓ → 0。
// 一个永远退 1 的 doctor 在脚本里等于没有。

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { hasMine } from '../core/card.ts'
import { loadCards } from '../core/kb.ts'
import { ownedTags } from '../core/mark.ts'
import { pluginDir } from '../core/plugin.ts'
import { redactText, scanRedaction } from '../core/redact.ts'
import { plistPath } from '../core/schedule.ts'
import { MARKER, PREFIX, skillsRoot, type SkillHost } from '../core/hostskills.ts'
import type { Ctx } from './ctx.ts'

type Level = 'ok' | 'warn' | 'bad'

export interface Item {
  level: Level
  text: string
  /**
   * 缩进的续行 —— 不贴标记,只缩进。
   *
   * 曾经用「text 以两个空格开头」来推断缩进,结果 `⚠  要让它…` 会渲染成
   * 「⚠」加三个空格。缩进是排版意图,不该靠字符串内容去猜。
   */
  sub?: true
}

export interface Section {
  title: string
  items: Item[]
}

/** 退出码只看有没有 ✗。⚠ 是「值得看一眼」,不该让脚本判失败。 */
export function hasBad(sections: Section[]): boolean {
  return sections.some(s => s.items.some(i => i.level === 'bad'))
}

const MARK: Record<Level, string> = { ok: '✓', warn: '⚠', bad: '✗' }

export async function runDoctor(ctx: Ctx): Promise<number> {
  const sections: Section[] = [
    hosts(),
    hotPath(),
    duplicates(),
    brain(ctx),
    knowledge(ctx),
    schedule(ctx),
    redaction(),
  ]

  const bad = hasBad(sections)

  if (ctx.args.bool('json')) {
    ctx.out(JSON.stringify({ ok: !bad, kb: ctx.kb, sections }, null, 2))
    return bad ? 1 : 0
  }

  ctx.out(`coach doctor  ·  知识库 ${ctx.kb}`)
  for (const s of sections) {
    ctx.out('')
    ctx.out(s.title)
    for (const i of s.items) {
      ctx.out(i.sub === true ? `    ${i.text}` : `  ${MARK[i.level]} ${i.text}`)
    }
  }
  ctx.out('')
  ctx.out(bad ? '✗ 有需要处理的问题(上面带 ✗ 的)。' : '✓ 没发现真问题。')
  return bad ? 1 : 0
}

// ---------------------------------------------------------------------------
// 宿主注入
// ---------------------------------------------------------------------------

const DEV_MODS = join(homedir(), '.claude', 'dev-mods')
const CODEX_AGENTS = join(homedir(), '.codex', 'AGENTS.md')
const WB_RULES = join(homedir(), '.workbuddy', 'rules', 'coach.md')

function hosts(): Section {
  const items: Item[] = []

  // --- Claude Code：旧 dev-mod ---
  const dev = findDevMod()
  if (dev === null) {
    items.push({
      level: 'warn',
      text: 'Claude Code  没找到旧 dev-mod(提问层)。本插件只做沉淀,**不替代提问** —— 两边都不在的话,「动手前先问你一句」那一步就没人管了。',
    })
  } else {
    items.push({
      level: 'ok',
      text: `Claude Code  旧 dev-mod 在场(v${dev.version})—— 它管提问层,本插件管沉淀层,互不接管`,
    })
    // 旧协议文件的 hash:漂了就说明那边动过,值得看一眼(不是错,是变化)
    if (dev.protocolHash !== null) {
      items.push({ sub: true, level: 'ok', text: `protocol/coach.md  sha256:${dev.protocolHash.slice(0, 12)}…` })
    }
  }

  // --- Codex ---
  if (!existsSync(CODEX_AGENTS)) {
    items.push({ level: 'warn', text: 'Codex  没有 ~/.codex/AGENTS.md —— 那边还没注入过协议' })
  } else {
    const text = readText(CODEX_AGENTS)
    const span = markSpan(text, 'coach')
    if (span === null) {
      items.push({ level: 'warn', text: 'Codex  ~/.codex/AGENTS.md 里没有 coach 段' })
    } else {
      items.push({ level: 'ok', text: `Codex  ~/.codex/AGENTS.md 有 coach 段(第 ${span[0]}–${span[1]} 行)` })
    }
  }

  // --- WorkBuddy ---
  if (existsSync(WB_RULES)) {
    items.push({ level: 'ok', text: 'WorkBuddy  ~/.workbuddy/rules/coach.md 独占' })
  } else {
    items.push({ level: 'warn', text: 'WorkBuddy  没有 ~/.workbuddy/rules/coach.md' })
  }

  // --- 沉淀层 skill(coach install --codex / --workbuddy 装的)---
  for (const host of ['codex', 'workbuddy', 'cursor'] as const) {
    items.push(skillCheck(host))
  }

  return { title: '宿主注入', items }
}

/**
 * skill 在不在、指向的 coach.mjs 还在不在。后者是最常见的坏法:
 * 仓库挪了位置,skill 里写死的绝对路径就悬空了,而那边的 AI 只会报「命令失败」。
 */
function skillCheck(host: SkillHost): Item {
  const label = host === 'codex' ? 'Codex' : host === 'cursor' ? 'Cursor' : 'WorkBuddy'
  const root = skillsRoot(host)
  const ours = existsSync(root) ? readdirSync(root).filter(n => n.startsWith(PREFIX) && existsSync(join(root, n, MARKER))) : []
  if (ours.length === 0) {
    return { level: 'warn', text: `${label}  沉淀层 skill 没装 —— coach install --${host} --yes` }
  }
  const dangling = new Set<string>()
  for (const n of ours) {
    const md = readText(join(root, n, 'SKILL.md'))
    for (const m of md.matchAll(/node ("[^"]+"|\S+coach\.mjs)/g)) {
      const p = (m[1] as string).replace(/^"|"$/g, '')
      if (!existsSync(p)) dangling.add(p)
    }
  }
  if (dangling.size > 0) {
    return { level: 'bad', text: `${label}  skill 指向的 ${[...dangling][0]} 不存在了(仓库挪过?)—— 重跑 coach install --${host} --yes` }
  }
  return { level: 'ok', text: `${label}  沉淀层 skill ${ours.length} 个(${ours.join(', ')})` }
}

interface DevMod {
  version: string
  protocolHash: string | null
}

function findDevMod(): DevMod | null {
  if (!existsSync(DEV_MODS)) return null
  let dirs: string[]
  try {
    dirs = readdirSync(DEV_MODS)
  } catch {
    return null
  }
  for (const d of dirs) {
    const root = join(DEV_MODS, d, 'coach')
    const manifest = join(root, '.claude-plugin', 'plugin.json')
    if (!existsSync(manifest)) continue
    let version = '?'
    try {
      const parsed = JSON.parse(readText(manifest)) as { version?: unknown }
      if (typeof parsed.version === 'string') version = parsed.version
    } catch {
      /* 读不动就当版本未知,不该据此报错 */
    }
    return { version, protocolHash: hashOf(join(root, 'protocol', 'coach.md')) }
  }
  return null
}

// ---------------------------------------------------------------------------
// 每次提交时谁在动
// ---------------------------------------------------------------------------

/**
 * 列出所有挂在 `UserPromptSubmit` 上的东西。
 *
 * 这不是洁癖:那是**每次回车**都要跑一遍的位置,而且它写进上下文的东西
 * 会和别人的混在一起。所以 doctor 要能回答「我敲一次回车,到底有几个
 * 东西醒过来,各自说了什么」。
 *
 * ★ 两类东西的形状完全不同,必须分别认:
 *   · 插件/dev-mod 的 hooks.json —— `{ hooks: { UserPromptSubmit: [...] } }`
 *   · 旧 coach dev-mod 的 hooks.json —— `{ modules: ["./register.tsx"] }`
 *     (它名字叫 hooks.json,但不是 hook 声明,是模块清单;走的是引擎 API)
 *   按第一种形状硬解第二种会抛,而 doctor 抛异常等于这次体检作废 —— 所以全程 try。
 */
function hotPath(): Section {
  const items: Item[] = []

  const plugin = pluginDir()
  if (plugin === null) {
    items.push({ level: 'bad', text: '找不到本插件的 plugin/ 目录 —— 装了也不会生效' })
  } else {
    const hooksFile = join(plugin, 'hooks', 'hooks.json')
    const declared = readHookEvents(hooksFile).includes('UserPromptSubmit')
    const hookBundle = join(plugin, 'dist', 'hook.mjs')
    const coachBundle = join(plugin, 'dist', 'coach.mjs')

    if (!declared) {
      items.push({ level: 'bad', text: 'plugin/hooks/hooks.json 没有声明 UserPromptSubmit —— 卡点提醒不会触发' })
    } else if (!existsSync(hookBundle)) {
      // 这条正是「从 git 装」的经典死法:声明在,文件不在
      items.push({ level: 'bad', text: 'hook 声明了,但 plugin/dist/hook.mjs 不存在 —— 每次回车都会静默失败。跑 bun run build' })
    } else {
      items.push({ level: 'ok', text: `本插件  UserPromptSubmit → plugin/dist/hook.mjs(${kb(existsSync(hookBundle) ? statSync(hookBundle).size : 0)})` })
    }
    if (!existsSync(coachBundle)) {
      items.push({ level: 'bad', text: 'plugin/dist/coach.mjs 不存在 —— /coach-kb:* 那几个 skill 会调不动' })
    }

    // 源码比产物新 = 插件里跑的是旧代码。这一条特别值得报:改完源码忘了 build,
    // 本机试装时看到的行为和你刚写的代码不一致,能查很久。
    const stale = newestSource(plugin) > mtimeOf(hookBundle)
    if (stale && existsSync(hookBundle)) {
      items.push({ sub: true, level: 'warn', text: 'dist 比 src 旧 —— 改了源码还没重新 build(跑 bun run build)' })
    }
  }

  // 别人也在这条路上吗
  for (const other of otherPromptHooks()) {
    items.push({
      level: 'warn',
      text: `${other.name}  也挂在 UserPromptSubmit(${other.note})—— 每次回车多一次开销`,
    })
  }

  return { title: '每次提交时谁在动', items }
}

interface OtherHook {
  name: string
  note: string
}

function otherPromptHooks(): OtherHook[] {
  const out: OtherHook[] = []
  const reg = join(homedir(), '.claude', 'plugins', 'installed_plugins.json')
  let parsed: { plugins?: Record<string, { installPath?: string }[]> } = {}
  try {
    parsed = JSON.parse(readText(reg)) as typeof parsed
  } catch {
    return out
  }
  for (const [key, entries] of Object.entries(parsed.plugins ?? {})) {
    if (key.startsWith('coach-kb@')) continue
    for (const e of entries) {
      if (e.installPath === undefined) continue
      if (!readHookEvents(join(e.installPath, 'hooks', 'hooks.json')).includes('UserPromptSubmit')) continue
      out.push({ name: key.split('@')[0] ?? key, note: '走它自己的脚本,不往上下文注入' })
    }
  }
  return out
}

/** 读出这个 hooks.json 声明了哪些事件。形状不认识就返回空 —— 不抛。 */
function readHookEvents(file: string): string[] {
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readText(file)) as { hooks?: Record<string, unknown> }
    if (parsed.hooks === undefined || parsed.hooks === null) return [] // 旧 dev-mod 的 {modules:[…]}
    return Object.keys(parsed.hooks)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// 重复注入
// ---------------------------------------------------------------------------

/**
 * 同一个段落被写了两遍。
 *
 * `stamp()` 靠「找得到自己的 BEGIN 串」来决定替换还是追加,所以正常情况
 * 永远只会有一段。出现两段只有一种可能:两边用的标记串不一样(比如
 * `coach` 与 `coach:rule` 是正常的两个槽位,但两个 `coach` 就是重复)。
 */
function duplicates(): Section {
  const items: Item[] = []
  let found = false

  for (const [label, file] of [
    ['Codex', CODEX_AGENTS],
    ['WorkBuddy', WB_RULES],
  ] as const) {
    if (!existsSync(file)) continue
    const tags = ownedTags(readText(file))
    const seen = new Map<string, number>()
    for (const t of tags) seen.set(t, (seen.get(t) ?? 0) + 1)
    for (const [tag, n] of seen) {
      if (n > 1) {
        found = true
        items.push({ level: 'bad', text: `${label}  ${tag} 段出现了 ${n} 次 —— 重复注入,删到只剩一段` })
      }
    }
    if (tags.length > 0 && !found) {
      items.push({ sub: true, level: 'ok', text: `${label}  段落标记:${tags.join(' / ')}(各一段)` })
    }
  }

  if (!found && items.length === 0) {
    items.push({ level: 'ok', text: '没有同一段落被写两遍' })
  } else if (!found) {
    items.unshift({ level: 'ok', text: '没有同一段落被写两遍' })
  }
  return { title: '重复注入', items }
}

// ---------------------------------------------------------------------------
// 脑子
// ---------------------------------------------------------------------------

function brain(ctx: Ctx): Section {
  const items: Item[] = []
  const st = ctx.state.brain
  const claude = onPath('claude')
  const codex = onPath('codex')

  if (!st.enabled || st.chosen === 'none') {
    items.push({ level: 'ok', text: '未启用(--brain none)→ 只产骨架卡,一个字节都不出本机' })
    items.push({
      level: 'warn',
      sub: true,
      text: '要让它补「为什么」:coach brain enable claude --yes —— 那意味着会话内容会离开本机(走你配置里的自定义端点,不是 Anthropic 官方)',
    })
  } else {
    items.push({ level: 'ok', text: `已启用:${st.chosen}(今天还剩 $${remaining(ctx).toFixed(2)} 额度)` })
    items.push({
      level: 'warn',
      sub: true,
      text: `注意:喂给 ${st.chosen} 的内容等于外发。见 docs/privacy.md`,
    })
  }

  for (const [bin, ok] of [['claude', claude], ['codex', codex]] as const) {
    if (!ok) items.push({ sub: true, level: 'warn', text: `PATH 里没有 ${bin} —— 这个脑用不了(装了才有)` })
  }

  return { title: '脑子', items }
}

function remaining(ctx: Ctx): number {
  const st = ctx.state
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  const today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  if (st.digest.spentDate !== today) return st.brain.maxUsdPerDay
  return Math.max(0, st.brain.maxUsdPerDay - st.digest.spentTodayUsd)
}

// ---------------------------------------------------------------------------
// 知识库
// ---------------------------------------------------------------------------

function knowledge(ctx: Ctx): Section {
  const items: Item[] = []
  let cards
  try {
    cards = loadCards(ctx.kb)
  } catch {
    items.push({ level: 'warn', text: '知识库读不动(权限?)—— 还没落过卡的话这是正常的' })
    return { title: '知识库', items }
  }

  if (cards.length === 0) {
    items.push({ level: 'ok', text: '还是空的 —— coach review --latest 看看最近这场会话有什么值得沉淀的' })
    return { title: '知识库', items }
  }

  let confirmed = 0
  let noMine = 0
  const texts: { path: string; text: string }[] = []
  for (const c of cards) {
    if (c.card.status === 'confirmed') confirmed += 1
    try {
      const text = readText(c.path)
      texts.push({ path: c.path, text })
      if (!hasMine(text)) noMine += 1
    } catch {
      /* 读不动就不算进缺表述,别拿一次 IO 抖动吓人 */
    }
  }

  items.push({
    level: 'ok',
    text: `${cards.length} 张卡 · ${confirmed} 张已认领 · ${cards.length - confirmed} 张待认领`,
  })
  if (noMine > 0) {
    items.push({
      level: 'warn',
      text: `${noMine} 张还没等到你自己那句话 —— 它们现在只是 AI 摘要,不是你的知识(coach kb --stale)`,
    })
  }

  // 卡多了检索会退化。不引向量库,但要让人知道斜率。
  if (cards.length > 500) {
    items.push({ level: 'warn', text: `${cards.length} 张已超过 500 —— kb 的朴素检索开始退化了,该考虑分库或上向量` })
  }

  const leaks = scanKbLeaks(texts)
  if (leaks.length > 0) {
    items.push({
      level: 'bad',
      text: `${leaks.length} 张卡里扫出了密钥形状的串 —— L3 漏了,或者是手改进去的。先遮掉再分享知识库`,
    })
    for (const l of leaks.slice(0, 5)) {
      items.push({ sub: true, level: 'bad', text: `${l.path}  (${l.rules.join('、')})` })
    }
  }

  return { title: '知识库', items }
}

/**
 * 落盘之后的真实扫描 —— canary 只证明脱敏器灵,证明不了盘上的卡干净。
 *
 * 用 scanRedaction 匹配**密钥形状**,而不是 grep `sk-|AKIA` 这类前缀词:
 * 后者会把正确遮罩后的 «REDACTED:api_key» 标记也报成泄露(见 design.md)。
 * 只报规则名,不回显命中原文 —— doctor 的输出常被贴进 issue。
 */
export function scanKbLeaks(files: { path: string; text: string }[]): { path: string; rules: string[] }[] {
  const out: { path: string; rules: string[] }[] = []
  for (const f of files) {
    const { ok, hits } = scanRedaction(f.text)
    if (ok) continue
    const rules = [...new Set(hits.map(h => h.slice(0, h.indexOf(':'))))]
    out.push({ path: f.path, rules })
  }
  return out
}

// ---------------------------------------------------------------------------
// 周期任务
// ---------------------------------------------------------------------------

/**
 * 周期任务装完之后**会烂**，而且是无声地烂。
 *
 * 三种烂法，全都不会报错：
 *   · 运行时路径消失（nvm 换版本最典型）→ launchd 每周失败一次，没人知道
 *   · bundle 被移走（仓库搬了、插件卸了）→ 同上
 *   · plist 改了但没重载 → launchd 跑的还是老那份
 *
 * 前两种这里逐条查文件在不在；第三种只能靠「装了很久但最近一次都没跑过」
 * 来间接发现。所以这个检查的核心是**比时间**，不是查配置。
 */
const STALE_SCHEDULE_DAYS = 10

interface PlistInfo {
  programArgs: string[]
  when: string
}

function schedule(ctx: Ctx): Section {
  const items: Item[] = []
  const path = plistPath()

  if (!existsSync(path)) {
    items.push({ level: 'ok', text: '没装周期任务(要的话:coach install --schedule,默认每周一 09:00)' })
    return { title: '周期任务', items }
  }

  const info = readPlist(path)
  if (info === null) {
    items.push({ level: 'bad', text: `${path} 读不动或不是合法 plist —— launchd 会当它不存在,而不会报错` })
    return { title: '周期任务', items }
  }

  const [node, bin, , kbFlag, kbPath] = info.programArgs
  items.push({ level: 'ok', text: `已装  ${info.when}  →  ${bin ?? '?'}` })

  // 运行时先看。nvm/fnm 的路径里带版本号，换一次版本就没了 ——
  // 这是最常见的烂法，所以单独报，而且要说清怎么修。
  if (node !== undefined && !existsSync(node)) {
    items.push({
      level: 'bad',
      text: `运行时不见了:${node} —— 换了 node 版本或者它被删了。这个任务每周会静默失败。用 coach install --schedule --node <稳的路径> --yes 重装`,
    })
  }
  if (bin !== undefined && !existsSync(bin)) {
    items.push({
      level: 'bad',
      text: `脚本不见了:${bin} —— 仓库搬了?插件卸了?这个任务每周会静默失败(coach install --schedule --yes 重装,或 coach install --unschedule --yes 撤掉)`,
    })
  }
  if (kbFlag !== undefined && kbFlag !== '--kb') {
    items.push({ level: 'warn', text: `plist 的参数形状不对(第 4 个是 ${kbFlag})—— 手工改过?重装一次` })
  }
  if (kbPath !== undefined && !existsSync(kbPath)) {
    items.push({ level: 'warn', text: `plist 记的知识库不在:${kbPath}(现在用的是 ${ctx.kb})` })
  }

  // 时间比对。装够了天数才有资格判「没跑」——
  // 刚装完就说人家没跑过是误报，而误报会让整个 doctor 被忽略。
  const ageDays = Math.floor((Date.now() - mtimeOf(path)) / 86400000)
  const last = ctx.state.digest.lastRunAt
  const lastDays = last === undefined ? null : Math.floor((Date.now() - Date.parse(last)) / 86400000)

  if (ageDays <= STALE_SCHEDULE_DAYS) {
    items.push({ sub: true, level: 'ok', text: `装了 ${ageDays} 天 —— 还看不出它有没有按时跑,过一周再看这条` })
  } else if (last === undefined) {
    items.push({
      level: 'warn',
      text: `装了 ${ageDays} 天,一次 digest 都没跑过 —— 多半没跑起来。日志在知识库的 .coach/logs/digest.err.log`,
    })
  } else if (lastDays !== null && lastDays > STALE_SCHEDULE_DAYS) {
    items.push({
      level: 'warn',
      text: `装了 ${ageDays} 天,最近一次 digest 是 ${last.slice(0, 10)}(${lastDays} 天前)—— 它可能没在按时跑`,
    })
  } else {
    items.push({ sub: true, level: 'ok', text: `最近一次 digest ${last.slice(0, 16).replace('T', ' ')}(手工或定时跑的都会记在这里)` })
  }

  return { title: '周期任务', items }
}

/**
 * 读 plist。
 *
 * 用系统的 `plutil -convert json` 而不是正则扒 XML —— 路径里带 `&` 或 `>`
 * 时正则就会读错，而读错的后果是 doctor 报一个不存在的路径。
 * plutil 读不动（非 macOS、文件坏了）就返回 null，让调用方去说那句话。
 */
function readPlist(path: string): PlistInfo | null {
  let out: string
  try {
    const r = spawnSync('plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8' })
    if (r.status !== 0 || typeof r.stdout !== 'string' || r.stdout === '') return null
    out = r.stdout
  } catch {
    return null
  }
  try {
    const p = JSON.parse(out) as {
      ProgramArguments?: unknown
      StartCalendarInterval?: { Weekday?: number; Hour?: number; Minute?: number }
    }
    if (!Array.isArray(p.ProgramArguments)) return null
    const args = p.ProgramArguments.filter((a): a is string => typeof a === 'string')
    const w = p.StartCalendarInterval ?? {}
    const zh = ['', '一', '二', '三', '四', '五', '六', '日']
    const p2 = (n: number | undefined): string => String(n ?? 0).padStart(2, '0')
    const when =
      w.Weekday === undefined
        ? `每天 ${p2(w.Hour)}:${p2(w.Minute)}`
        : `每周${zh[w.Weekday] ?? '?'} ${p2(w.Hour)}:${p2(w.Minute)}`
    return { programArgs: args, when }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 脱敏抽查
// ---------------------------------------------------------------------------

/**
 * canary 表:每条的 `secret` 在 `redactText` 之后**必须消失**。
 *
 * 判据故意写成「密钥原文还在不在」而不是「哪条规则命中了」——
 *   · 前者是真正要保证的性质(密钥不出本机),规则怎么改名、谁先谁后都不影响它
 *   · 后者把测试绑死在 RULES 的顺序和命名上,重构一次就红一片,然后被人删掉
 *
 * 这些 canary 的字面量刻意避开 WHITELIST_RE 里的 test/fake/example 等词 ——
 * 否则会被白名单放行,doctor 会误报「脱敏失效」。
 */
export const CANARIES: { what: string; secret: string; text: string }[] = [
  { what: '私钥块', secret: 'MIIEowIBAAKCAQEAq7Vv3kQmZ1xY8pLd2nRc5tHb4sJf', text: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAq7Vv3kQmZ1xY8pLd2nRc5tHb4sJf\n-----END RSA PRIVATE KEY-----' },
  { what: 'sk- 密钥', secret: 'sk-Qw8zR2mK9pL4xV7nB1dF6hJ3tY5cA0s', text: 'key: sk-Qw8zR2mK9pL4xV7nB1dF6hJ3tY5cA0s' },
  { what: 'GitHub token', secret: 'ghp_Qw8zR2mK9pL4xV7nB1dF6hJ3tY5cA0sZr', text: 'ghp_Qw8zR2mK9pL4xV7nB1dF6hJ3tY5cA0sZr' },
  { what: 'AWS key', secret: 'AKIAQW8ZR2MK9PL4XV7N', text: 'AKIAQW8ZR2MK9PL4XV7N' },
  { what: 'Slack token', secret: 'xoxb-918273645012-Ph4kLm9Qs', text: 'xoxb-918273645012-Ph4kLm9Qs' },
  { what: 'JWT', secret: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.Qw8zR2mK9pL4xV7nB1dF6hJ3tY5cA0s', text: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.Qw8zR2mK9pL4xV7nB1dF6hJ3tY5cA0s' },
  { what: 'Bearer 头', secret: 'Qw8zR2mK9pL4xV7nB1dF6hJ3tY5cA0s', text: 'Authorization: Bearer Qw8zR2mK9pL4xV7nB1dF6hJ3tY5cA0s' },
  { what: 'X-Api-Key', secret: 'Qw8zR2mK9pL4xV7nB1dF6hJ3tY5cA0s', text: 'X-Api-Key: Qw8zR2mK9pL4xV7nB1dF6hJ3tY5cA0s' },
  { what: '连接串密码', secret: 'Qw8zR2mK9pL4xV7', text: 'postgres://coach:Qw8zR2mK9pL4xV7@db.internal:5432/app' },
  { what: '_AUTH/_TOKEN 赋值', secret: 'Qw8zR2mK9pL4xV7nB1dF6hJ3tY5cA0s', text: 'ANTHROPIC_AUTH_TOKEN=Qw8zR2mK9pL4xV7nB1dF6hJ3tY5cA0s' },
  { what: '厂商前缀密钥', secret: 'Qw8zR2mK9pL4xV7nB1dF6hJ3tY5cA0s', text: 'deepseek_api_key: Qw8zR2mK9pL4xV7nB1dF6hJ3tY5cA0s' },
  { what: 'password= 赋值', secret: 'Qw8zR2mK9pL4xV7nB1dF6hJ3tY5cA0s', text: 'password = Qw8zR2mK9pL4xV7nB1dF6hJ3tY5cA0s' },
]

function redaction(): Section {
  const leaked: string[] = []
  let suspects = 0

  for (const c of CANARIES) {
    const r = redactText(c.text)
    suspects += r.suspects
    // 两道都要过:原文消失,且遮罩后的结果本身扫不出残留
    if (r.text.includes(c.secret) || !scanRedaction(r.text).ok) leaked.push(c.what)
  }

  const items: Item[] = []
  if (leaked.length === 0) {
    items.push({ level: 'ok', text: `${CANARIES.length}/${CANARIES.length} 条 canary 的密钥原文都已被遮罩` })
  } else {
    items.push({
      level: 'bad',
      text: `${leaked.length}/${CANARIES.length} 条漏了:${leaked.join('、')} —— 这些会随 IR 一起发出去,先别 enable 脑`,
    })
  }
  // 高熵那条只统计不判定 —— 它会误伤真 commit sha,报出来让人自己看
  if (suspects > 0) {
    items.push({ sub: true, level: 'ok', text: `(另有 ${suspects} 处高熵串被标为 SUSPECT —— 它可能误伤,只标记不替换)` })
  }
  return { title: '脱敏抽查', items }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function hashOf(file: string): string | null {
  if (!existsSync(file)) return null
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

/** 标记段在文件里的起止行(1-based)。找不到返回 null。 */
function markSpan(text: string, tag: string): [number, number] | null {
  const lines = text.split('\n')
  const from = lines.findIndex(l => l.includes(`<!-- ${tag}:begin`))
  if (from === -1) return null
  const to = lines.findIndex((l, i) => i > from && l.includes(`<!-- ${tag}:end`))
  return [from + 1, to === -1 ? from + 1 : to + 1]
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** src 下最新的一个 .ts 的 mtime。用来判断「改了源码没重新 build」。 */
function newestSource(plugin: string): number {
  const src = join(dirname(plugin), 'src')
  let newest = 0
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(p)
      else if (e.endsWith('.ts') && st.mtimeMs > newest) newest = st.mtimeMs
    }
  }
  walk(src)
  return newest
}

function onPath(bin: string): boolean {
  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    if (dir !== '' && existsSync(join(dir, bin))) return true
  }
  return false
}

function kb(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`
}
