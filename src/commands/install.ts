// `coach install` —— 把插件装到宿主上。语义从旧 coach 的 scripts/install.mjs 吸收:
// **幂等、可预演、可干净撤回**。那三条不是好习惯,是这个命令能不能被信任的前提 ——
// 一个装不明白也删不干净的安装器,没人敢跑第二遍。
//
// ★ 默认**只预演,不动手**。
//
// `claude plugin marketplace add` / `install` 改的是用户**全局**的 Claude 配置,
// 而且它会往那个文件系统里拷东西。这种事得由人开口。所以:
//   coach install --claude-code          预演,打印命令,一个字节都不改
//   coach install --claude-code --yes    真跑
// 这个 --yes 惯例跟 brain enable 一致 —— 项目里凡是「会离开本机 / 会动全局状态」
// 的动作都要求它。一致性在这里是有用的:用户学一次就够。
//
// 还有一个容易忽略的点:装机顺序里**必须先试跑**。
//   claude --plugin-dir <plugin>   只在这次会话里加载,不改全局
// 出问题(比如 hook 报错、skill 不出现)时,代价是关掉这个会话,而不是
// 去全局配置里翻。所以预演的输出把这条排在正式安装前面。

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { renderDefaultConfig } from '../core/config.ts'
import { pluginDir } from '../core/plugin.ts'
import {
  LABEL,
  defaultSpec,
  describeSchedule,
  launchdDomain,
  plistPath,
  renderPlist,
  type ScheduleSpec,
} from '../core/schedule.ts'
import { MARKER, PREFIX, renderHostSkill, skillPlan, skillsRoot, type SkillHost } from '../core/hostskills.ts'
import type { Ctx } from './ctx.ts'

const PLUGIN_ID = 'coach-kb@coach-kb'
const MARKETPLACE = 'coach-kb'
const SKILLS = ['review', 'coach', 'save', 'kb', 'due']

export async function runInstall(ctx: Ctx): Promise<number> {
  const { args, out, err } = ctx

  const dry = !args.bool('yes') && !args.bool('i-know')

  // Codex / WorkBuddy 走自己的分支 —— 它们不碰 claude 的全局配置,
  // 而且 `--codex --uninstall` 必须只撤 Codex 那份,不能落到下面撤 Claude 插件的分支里。
  const skillHost: SkillHost | null = args.bool('codex') ? 'codex' : args.bool('workbuddy') ? 'workbuddy' : args.bool('cursor') ? 'cursor' : null
  if (skillHost !== null) {
    const removing = args.bool('uninstall') || args.bool('remove')
    if (removing) return hostSkillsRemove(ctx, skillHost, dry)
    const plugin = pluginDir()
    if (plugin === null) {
      err('✗ 找不到 plugin/ 目录。用 COACH_PLUGIN_DIR=<仓库>/plugin 指一下。')
      return 2
    }
    return hostSkillsInstall(ctx, skillHost, plugin, dry)
  }

  if (args.bool('uninstall') || args.bool('remove')) return uninstall(ctx)

  // LaunchAgent 的增删**不依赖插件目录**，所以排在它前面。
  // 顺序有实际后果：插件装不上是麻烦，定时任务撤不掉才是坑 ——
  // 它会每周默默去跑一个可能已经不存在的文件，失败得悄无声息。
  if (args.bool('unschedule')) return scheduleRemove(ctx, !dry)

  const plugin = pluginDir()
  if (plugin === null) {
    err('✗ 找不到 plugin/ 目录 —— 跑这个命令的脚本不在仓库里,也不是插件里那份。')
    err('  提示:用 COACH_PLUGIN_DIR=<仓库>/plugin 指一下。')
    return 2
  }

  if (args.bool('self-test')) return selfTest(ctx, plugin)
  if (args.bool('schedule')) return scheduleInstall(ctx, plugin, dry)

  out(`coach install --claude-code${dry ? '  (预演 —— 什么都没改)' : ''}`)
  out(`  插件目录  ${plugin}`)
  out('')

  // ---- 1. 自包含检查 ------------------------------------------------------
  // 这一节不能省。插件从 git/url/npm 装时会被**拷进缓存**,
  // 「插件目录之外的文件不会被拷」—— 所以 bundle 必须在 plugin/dist/ 里。
  // 缺了的话,声明完美、装完不生效,而且不报错。
  out('1. 插件自包含检查')
  const missing = selfContained(plugin)
  if (missing.length > 0) {
    for (const m of missing) err(`   ✗ 缺 ${m}`)
    err('')
    err('   插件必须自包含(bundle 放 plugin/dist/,不能引用 ../dist)。')
    err('   跑 bun run build 会把它同步过去。')
    return 1
  }
  out(`   ✓ .claude-plugin/plugin.json`)
  out(`   ✓ hooks/hooks.json → UserPromptSubmit`)
  out(`   ✓ dist/hook.mjs (${size(join(plugin, 'dist', 'hook.mjs'))})`)
  out(`   ✓ dist/coach.mjs (${size(join(plugin, 'dist', 'coach.mjs'))})`)
  out(`   ✓ skills/${SKILLS.join(',')}`)
  out('')

  // ---- 2. 知识库配置 ------------------------------------------------------
  out('2. 知识库配置')
  const cfg = ctx.paths.config
  if (existsSync(cfg)) {
    out(`   · ${cfg} 已存在,不动它(那是你的意图,覆盖它等于替你改主意)`)
  } else if (dry) {
    out(`   · 会写 ${cfg}(hook 默认开着,六小时最多提醒一次)`)
  } else {
    writeFileSync(cfg, renderDefaultConfig(), { mode: 0o600 })
    out(`   ✓ 写了 ${cfg}`)
    out('     hook.enabled=false 可以一次都不提醒;minGapSeconds / maxPerDay 在同一个文件里')
  }
  out('')

  // ---- 3. 宿主注册 --------------------------------------------------------
  out('3. 注册到 Claude Code')

  const mkAdd = ['plugin', 'marketplace', 'add', plugin]
  const mkInstall = ['plugin', 'install', PLUGIN_ID]

  out('   a) 先只在本会话试跑(不改全局配置):')
  out(`        claude --plugin-dir ${plugin}`)
  out('      新开一个会话,跑 /coach-kb:review;同时确认旧的 /coach on|off|skip 照常。')
  out('')
  out('   b) 满意后正式装:')
  out(`        claude ${mkAdd.join(' ')}`)
  out(`        claude ${mkInstall.join(' ')}`)
  out('')
  out('      (一条命令的等价写法:')
  out(`        claude plugin install coach-kb --marketplace ${plugin}`)
  out('      —— 未添加过的 marketplace 会先自动添加。但分两步更看得清动了什么。)')

  if (!dry) {
    out('')
    out('   正在跑……')
    // stdio 继承:确认提示要留给用户本人看到。我们不替他接受任何东西,
    // 所以**不加 -y** —— 需要确认就让他自己确认。
    for (const argv of [mkAdd, mkInstall]) {
      const r = spawnSync('claude', argv, { stdio: 'inherit' })
      if (r.error !== undefined && r.error !== null) {
        err(`   ✗ 跑不动 claude:${r.error.message}`)
        return 1
      }
      if (r.status !== 0) {
        err(`   ✗ claude ${argv.join(' ')} 退出码 ${r.status ?? '?'}`)
        return r.status ?? 1
      }
    }
    out('')
    out('✓ 装完了。跑 coach doctor 确认一眼(它会报 hook 有没有真的挂上)。')
    return 0
  }

  out('')
  out('要我现在就跑 a/b 里的正式安装,加 --yes:')
  out('  coach install --claude-code --yes')
  return 0
}

// ---------------------------------------------------------------------------

/**
 * `--self-test` —— 只断言,不碰宿主。从旧 install.mjs 的 `--self-test` 吸收。
 *
 * 装之前先自己回答「我这份插件是完整的吗」。这比装完再发现问题便宜得多,
 * 而且能进 CI。
 */
function selfTest(ctx: Ctx, plugin: string): number {
  const { out, err } = ctx
  let bad = 0

  out(`coach install --self-test  ·  ${plugin}`)
  out('')

  const skills = skillFiles(plugin)
  for (const s of skills) {
    if (s.ok) out(`  ✓ skills/${s.name}/SKILL.md`)
    else {
      bad += 1
      err(`  ✗ skills/${s.name}/SKILL.md 缺失或没有 frontmatter —— /coach-kb:${s.name} 不会存在`)
    }
  }

  if (configIsStable()) {
    out('  ✓ 默认配置两次渲染逐字节相同,且是合法 JSON')
  } else {
    bad += 1
    err('  ✗ 默认配置渲染不稳定或不是合法 JSON —— 写出去会是个坏文件')
  }

  // skills 上面已经逐条报过了,这里只报剩下的 —— 同一个缺失说两遍
  // 会让「12 项没过」这个数字虚高,而数字虚高的自检很快就没人看了
  const missing = selfContained(plugin).filter(m => !m.startsWith('skills/'))
  for (const m of missing) {
    bad += 1
    err(`  ✗ 缺 ${m}`)
  }
  if (missing.length === 0) out('  ✓ 自包含(plugin/dist/ 里两个 bundle 都在)')

  // 渲染出来的 plist 必须能被 launchd 认。认不了的话它对这个任务的反应是
  // **这个任务不存在** —— 一声不吭。属于「坏法是静的」那一类，只能靠断言拦。
  if (process.platform === 'darwin') {
    if (plistLints(plugin)) out('  ✓ 渲染出的 plist 过得了 plutil -lint(含 & < 转义)')
    else {
      bad += 1
      err('  ✗ 渲染出的 plist 过不了 plutil -lint —— launchd 会当它不存在,而不会报错')
    }
  }

  out('')
  if (bad === 0) {
    out('✓ 自检通过。')
    return 0
  }
  err(`✗ ${bad} 项没过。`)
  return 1
}

// ---------------------------------------------------------------------------
// 周期任务（LaunchAgent，macOS）
// ---------------------------------------------------------------------------

/**
 * 越界就报错，**不夹到边界**。
 *
 * `--hour 25` 夹成 23 的话，用户会以为自己设的是 25 点附近而实际是别的时间，
 * 而且看不出来。定时任务本来就没人盯着，这里的错必须当场说。
 */
function intIn(ctx: Ctx, name: string, fallback: number, lo: number, hi: number): number | null {
  const v = ctx.args.num(name, fallback)
  if (!Number.isInteger(v) || v < lo || v > hi) {
    ctx.err(`✗ --${name} 得是 ${lo}–${hi} 之间的整数，给的是 ${v}`)
    return null
  }
  return v
}

function specFor(ctx: Ctx, plugin: string): ScheduleSpec | null {
  const { args, err } = ctx
  const weekday = intIn(ctx, 'weekday', 1, 1, 7)
  const hour = intIn(ctx, 'hour', 9, 0, 23)
  const minute = intIn(ctx, 'minute', 0, 0, 59)
  if (weekday === null || hour === null || minute === null) return null

  const base = defaultSpec({
    // `process.execPath` 是**正在跑这个 CLI 的那个运行时**的绝对路径。
    // 写死 "node" 不行：launchd 的 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，
    // homebrew 的 /opt/homebrew/bin 和 nvm 都不在里面 ——
    // 那样这个任务会每周静默失败一次，而没有任何地方会告诉你。
    node: args.get('node') ?? process.execPath,
    bin: args.get('bin') ?? join(plugin, 'dist', 'coach.mjs'),
    kb: ctx.kb,
    logDir: ctx.paths.logs,
  })

  // 两个绝对路径都得真的存在。launchd 对「文件不在」的反应是任务从此不存在，
  // 一声不吭 —— 这正是要在装的时候拦住的那类失败。
  if (!existsSync(base.bin)) {
    err(`✗ 找不到要跑的脚本:${base.bin}`)
    err('  先跑 bun run build（它会把 bundle 同步到 plugin/dist/），或用 --bin 指一个。')
    return null
  }
  if (!existsSync(base.node)) {
    err(`✗ 找不到运行时:${base.node}（用 --node 指一个绝对路径）`)
    return null
  }
  return { ...base, weekday, hour, minute }
}

function launchdLoaded(): boolean {
  const r = spawnSync('launchctl', ['print', `${launchdDomain(uid())}/${LABEL}`], { stdio: 'ignore' })
  return r.status === 0
}

function uid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : 0
}

/**
 * 版本管理器装的 node，路径里带着版本号。
 *
 * `~/.nvm/versions/node/v25.7.0/bin/node` 是**当下这个版本**的路径 ——
 * 换一次 node 版本它就没了，而 launchd 对此的反应照旧是「什么都不发生」。
 * 这是这个文件最容易烂的地方，所以要在装的那一刻就喊出来，而不是等一周后
 * 靠 doctor 去发现。
 */
const VOLATILE_RUNTIME = /(\.nvm\/versions\/node|\.fnm\/node-versions|\.volta|\.asdf\/installs|\.local\/share\/mise)/

function volatileRuntime(node: string): boolean {
  return VOLATILE_RUNTIME.test(node)
}

function scheduleInstall(ctx: Ctx, plugin: string, dry: boolean): number {
  const { args, out, err } = ctx

  // plist 是 macOS 的东西。在别的系统上写一个它不认的文件，比不写更糟 ——
  // 用户会以为已经安排上了。所以这里直说不支持，并且给出等价的手工做法。
  if (process.platform !== 'darwin') {
    err(`✗ 周期任务目前只实现了 macOS 的 launchd（当前是 ${process.platform}）。`)
    err('  手工挂 cron 是一样的效果 —— digest 不调模型、不联网、毫秒级：')
    err(`    ${process.execPath} ${join(plugin, 'dist', 'coach.mjs')} digest --kb ${ctx.kb}`)
    return 2
  }

  const spec = specFor(ctx, plugin)
  if (spec === null) return 2

  const path = plistPath()
  const body = renderPlist(spec)
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null
  const checkOnly = args.bool('check')

  out(`coach install --schedule${checkOnly ? '  (只看状态,什么都不写)' : dry ? '  (预演 —— 什么都没改)' : ''}`)
  out('')
  out(`  时间      ${describeSchedule(spec)}`)
  out(`  运行时    ${spec.node}`)
  out(`  脚本      ${spec.bin}`)
  out(`  知识库    ${spec.kb}`)
  out(`  日志      ${spec.stdout}`)
  out(`  落点      ${path}`)
  out(`  现状      ${before === null ? '还没装' : before === body ? '已装,内容一致' : '已装,但内容不同'} · launchd ${launchdLoaded() ? '已加载' : '未加载'}`)
  out('')
  out('  它跑的 `coach digest` 一次模型都不调、不联网 —— 定时任务出错时没人看得见,')
  out('  所以「可能花钱」的那条路从一开始就不许进这个文件。')
  if (volatileRuntime(spec.node)) {
    out('')
    err('  ⚠ 这个运行时是版本管理器装的,路径里带着版本号 ——')
    err('    换一次 node 版本它就不在了,而 launchd 对此的反应是**每周静默失败**。')
    err('    稳一点:--node <不随版本变的那条>,拿 `which -a node` 挑一个系统级的。')
    err('    (真要这么装也行 —— coach doctor 会一直替你盯着这条路径。)')
  }
  out('')

  if (checkOnly) {
    const same = before === body
    if (same && launchdLoaded()) out('✓ 一切就绪。')
    else if (same) out('· 文件对,但 launchd 还没加载它。跑 coach install --schedule --yes 重装一次。')
    else if (before === null) out('· 还没装。跑 coach install --schedule 看要写什么,再加 --yes。')
    else out('· 文件内容跟现在这份对不上(比如换了知识库或改了时间)。跑一遍 --yes 会覆盖并重载。')
    return 0
  }

  if (dry) {
    out('会写下面这个文件（要真写,加 --yes）：')
    out('')
    out(body)
    return 0
  }

  mkdirSync(ctx.paths.logs, { recursive: true, mode: 0o700 })
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 })

  if (before === body) {
    out(`· ${path} 未变`)
  } else {
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, body, { mode: 0o644 })
    renameSync(tmp, path)
    out(`${before === null ? '＋ 写了' : '↻ 更新了'} ${path}`)
  }

  // ★ 改过就必须重载。launchd 缓存的是**加载那一刻**那份 plist：
  //   同一个 label 直接再 bootstrap 会报 already bootstrapped，
  //   文件改了但跑的还是老配置 —— 一场查半天的哑谜。先 bootout 再 bootstrap。
  const domain = launchdDomain(uid())
  spawnSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' }) // 没加载时失败是正常的
  const r = spawnSync('launchctl', ['bootstrap', domain, path], { stdio: 'pipe', encoding: 'utf8' })
  if (r.status !== 0) {
    err(`✗ launchctl bootstrap 失败（退出码 ${r.status ?? '?'}）`)
    const said = (r.stderr ?? '').trim()
    if (said !== '') err(`  ${said}`)
    err('  文件已经写好了,是加载这一步没过 —— 修好再加 --yes 跑一遍。')
    return 1
  }
  out('↻ launchd 已加载')

  if (args.bool('run-now')) {
    const k = spawnSync('launchctl', ['kickstart', '-p', `${domain}/${LABEL}`], { stdio: 'ignore' })
    if (k.status !== 0) {
      err(`✗ kickstart 失败（退出码 ${k.status ?? '?'}）—— 文件装上了,但跑不起来`)
      return 1
    }
    out(`▶ 已经立刻跑了一次。看结果:cat ${spec.stdout}`)
  }

  out('')
  out('✓ 安排好了。头一周建议确认一次它真的跑了 —— `coach doctor` 会比对')
  out('  最后一次 digest 的时间；一直不动就说明它没跑起来（那种失败不出声）。')
  out(`  不想跑了:coach install --unschedule --yes`)
  return 0
}

function scheduleRemove(ctx: Ctx, yes: boolean): number {
  const { out } = ctx
  const path = plistPath()
  out(`coach install --unschedule${yes ? '' : '  (预演 —— 什么都没改)'}`)
  out('')

  if (!existsSync(path)) {
    out(`  · ${path} 不存在,没什么可撤的`)
    return 0
  }
  if (!yes) {
    out(`  ⇢ 会撤 ${path}`)
    if (launchdLoaded()) out(`  ⇢ 会从 launchd 卸载 ${LABEL}`)
    out('')
    out('要真撤,加 --yes:coach install --unschedule --yes')
    return 0
  }

  if (launchdLoaded()) {
    spawnSync('launchctl', ['bootout', `${launchdDomain(uid())}/${LABEL}`], { stdio: 'ignore' })
    out('  ↻ 已从 launchd 卸载')
  }
  rmSync(path)
  out(`  ↻ 已删 ${path}`)
  out('')
  out('✓ 撤完了。已经生成的那些 digests/*.md 是你的东西,没动。')
  return 0
}

// ---------------------------------------------------------------------------

function uninstall(ctx: Ctx): number {
  const { out, args } = ctx
  const dry = !args.bool('yes') && !args.bool('i-know')

  out(`coach install --uninstall${dry ? '  (预演 —— 什么都没改)' : ''}`)
  out('')
  out('  会跑:')
  out(`    claude plugin uninstall ${PLUGIN_ID}`)
  out(`    claude plugin marketplace remove ${MARKETPLACE}`)
  if (existsSync(plistPath())) out(`    撤掉周期任务 ${plistPath()}`)
  out('')
  out('  知识库**不会被删** —— 那是你自己写的 Markdown,装在 ~/knowledge,')
  out('  与插件无关。想一起清掉就自己 rm -rf。')
  out('')
  out('  周期任务会一起撤掉:留下它的话,launchd 会每周去跑一个可能已经不存在的')
  out('  脚本 —— 那种失败不出声,没人会知道。想留着:先 --unschedule 单独处理。')
  out('')

  if (dry) {
    out('要真删,加 --yes:coach install --uninstall --yes')
    return 0
  }

  if (existsSync(plistPath())) scheduleRemove(ctx, true)

  for (const argv of [
    ['plugin', 'uninstall', PLUGIN_ID],
    ['plugin', 'marketplace', 'remove', MARKETPLACE],
  ]) {
    const r = spawnSync('claude', argv, { stdio: 'inherit' })
    if (r.error !== undefined && r.error !== null) {
      ctx.err(`   ✗ 跑不动 claude:${r.error.message}`)
      return 1
    }
    // 卸载时「本来就没装」不该算失败 —— 幂等的意思就是重复跑不出错
    if (r.status !== 0) ctx.err(`   · claude ${argv.join(' ')} 退出码 ${r.status ?? '?'}(可能本来就没装,继续)`)
  }
  out('')
  out('✓ 已撤回。旧 coach 的 /coach 不受影响 —— 本插件从没碰过它。')
  return 0
}

// ---------------------------------------------------------------------------

/** 缺了哪个就说哪个 —— 「✗ 插件不完整」这种话没法让人去修。 */
function selfContained(plugin: string): string[] {
  const need = [
    '.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
    'hooks/hooks.json',
    'dist/hook.mjs',
    'dist/coach.mjs',
    ...SKILLS.map(s => `skills/${s}/SKILL.md`),
    // WorkBuddy 的 report skill 模板:从 git 装的插件里也得有,否则 install --workbuddy 装不全
    'hosts/workbuddy/report/SKILL.md',
    // 没有 hook 的宿主靠它做「旧卡命中」
    'hosts/common/recall/SKILL.md',
  ]
  return need.filter(rel => !existsSync(join(plugin, rel)))
}

function size(file: string): string {
  try {
    const n = statSync(file).size
    return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`
  } catch {
    return '?'
  }
}

/** 供 `--self-test`:同一份默认配置写两次必须逐字节相同。 */
export function configIsStable(): boolean {
  const a = renderDefaultConfig()
  const b = renderDefaultConfig()
  if (a !== b) return false
  // 也确认它是能解析的 JSON —— 写出去一个解析不了的文件比不写更糟
  try {
    JSON.parse(a)
    return true
  } catch {
    return false
  }
}

/** 测试用:确认 4 个 skill 都在(导出是为了不必真的装一遍)。 */
export function skillFiles(plugin: string): { name: string; ok: boolean }[] {
  return SKILLS.map(name => {
    const f = join(plugin, 'skills', name, 'SKILL.md')
    if (!existsSync(f)) return { name, ok: false }
    // 有 frontmatter 才算数 —— 一个空的 SKILL.md 会让 /coach-kb:<name> 不存在
    return { name, ok: readFileSync(f, 'utf8').startsWith('---\n') }
  })
}

/**
 * `plutil -lint` 渲染结果。
 *
 * 顺带用带 `&` 和 `<` 的路径验一遍转义 —— 那是同一类失败：转义漏了
 * plutil 会直接解析失败，而 launchd 对此的反应是任务不存在。
 * 导出是为了单测能直接调，不必先装一遍。
 */
export function plistLints(plugin: string): boolean {
  const spec = defaultSpec({
    node: process.execPath,
    bin: join(plugin, 'dist', 'coach.mjs'),
    kb: join(tmpdir(), 'coach&lint', 'kb<cache>'),
    logDir: join(tmpdir(), 'coach&lint', 'kb<cache>', '.coach', 'logs'),
  })
  const f = join(tmpdir(), `coach-plist-lint-${process.pid}.plist`)
  try {
    writeFileSync(f, renderPlist(spec))
    return spawnSync('plutil', ['-lint', f], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  } finally {
    rmSync(f, { force: true })
  }
}

// ---------------------------------------------------------------------------
// Codex / WorkBuddy:装 skill
// ---------------------------------------------------------------------------

const HOST_LABEL: Record<SkillHost, string> = { codex: 'Codex', workbuddy: 'WorkBuddy', cursor: 'Cursor' }

function hostSkillsInstall(ctx: Ctx, host: SkillHost, plugin: string, dry: boolean): number {
  const { out, err } = ctx
  const root = skillsRoot(host)
  // 指向插件里那份 bundle:它自包含(只依赖 node:*),仓库挪了位置重跑一次 install 即可
  const coach = resolve(plugin, 'dist', 'coach.mjs')
  if (!existsSync(coach)) {
    err(`✗ 缺 ${coach} —— 先跑 bun run build`)
    return 1
  }

  out(`coach install --${host}${dry ? '  (预演 —— 什么都没改)' : ''}`)
  out(`  skill 目录  ${root}`)
  out(`  CLI         node ${coach}`)
  out('')

  let conflicts = 0
  for (const { name, from, hostDir } of skillPlan(host)) {
    const src = from === 'plugin' ? join(plugin, 'skills', name, 'SKILL.md') : join(plugin, 'hosts', hostDir ?? host, name, 'SKILL.md')
    if (!existsSync(src)) {
      err(`  ✗ 缺模板 ${src}`)
      return 1
    }
    const dir = join(root, PREFIX + name)
    const target = join(dir, 'SKILL.md')
    // 同名目录但不是我们装的 —— 不覆盖。别人的 skill 不是我们能动的
    if (existsSync(dir) && !existsSync(join(dir, MARKER))) {
      err(`  ✗ ${dir} 已存在且不是 coach-kb 装的,跳过`)
      conflicts += 1
      continue
    }
    const md = renderHostSkill(readFileSync(src, 'utf8'), { host, coach })
    const same = existsSync(target) && readFileSync(target, 'utf8') === md
    out(`  ${same ? '·' : '＋'} ${PREFIX}${name}${same ? '  (没变)' : ''}`)
    if (dry || same) continue
    mkdirSync(dir, { recursive: true })
    writeFileSync(target, md)
    writeFileSync(join(dir, MARKER), `coach-kb ${host} skill\n`)
  }
  out('')

  if (dry) {
    out(`要真装,加 --yes:coach install --${host} --yes`)
    return conflicts > 0 ? 1 : 0
  }
  out(`✓ 装好了。新开一个 ${HOST_LABEL[host]} 会话,说「复盘一下」或直接点名 ${PREFIX}${host === 'codex' ? 'review' : 'report'}。`)
  out(`  卡住时说「没懂」→ ${PREFIX}coach 追问;说「复习一下」→ ${PREFIX}due。知识库和 Claude Code 共用 ${ctx.kb}`)
  if (host === 'cursor') out('  (Cursor 不读会话、不装 hook:复盘由那边的 AI 整理后 report 上报,见 docs/hosts.md)')
  if (host === 'codex') out('  (不装 hook:Codex 的 hook 要手动 /hooks 信任一次才生效,见 docs/integration.md)')
  out(`  卸载:coach install --${host} --uninstall --yes`)
  return conflicts > 0 ? 1 : 0
}

function hostSkillsRemove(ctx: Ctx, host: SkillHost, dry: boolean): number {
  const { out } = ctx
  const root = skillsRoot(host)
  out(`coach install --${host} --uninstall${dry ? '  (预演 —— 什么都没改)' : ''}`)
  const ours = existsSync(root)
    ? readdirSync(root).filter(n => n.startsWith(PREFIX) && existsSync(join(root, n, MARKER)))
    : []
  if (ours.length === 0) {
    out('  没有装过(或已经撤干净了)')
    return 0
  }
  for (const n of ours) {
    out(`  − ${join(root, n)}`)
    if (!dry) rmSync(join(root, n), { recursive: true, force: true })
  }
  out('')
  out(dry ? `要真删,加 --yes:coach install --${host} --uninstall --yes` : '✓ 撤完了。知识库没动。')
  return 0
}
