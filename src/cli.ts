#!/usr/bin/env node
// coach —— 把 AI 干过的活变成你自己的知识。
//
// 手写路由,零依赖。理由不是"少装一个包",是这个 CLI 会被 hook 以
// <100ms 的预算调用(见 hook/entry.ts),而每多一层 import 就多一次
// 模块解析。子命令的加载因此是**按需**的:只有真要跑 distill 时,
// 才去 import 那些跟模型、跟解析器有关的重家伙。
//
// 三个动词要说清楚,它们的边界是这个项目的设计核心:
//
//   review   看这场会话里有哪些卡点。**不落盘。** 只提问。
//   distill  把卡点落成半成品卡(骨架 + AI 补充)。status: inbox。
//   save     用你自己的话认下一张卡。**这一步之前,它都不算你的知识。**

import { Args } from './args.ts'
import { makeCtx } from './commands/ctx.ts'

const USAGE = `coach —— 把 AI 干过的活变成你自己的知识

用法:  coach <命令> [选项]

  review     看一场会话里的卡点,不落盘(默认最新一场)
             --latest | --session <id|路径>   --json   --save   --limit N
             --host claude-code|codex   读哪个宿主的会话(默认 claude-code)
  distill    把卡点落成半成品卡,补上 AI 的「为什么」
             --latest | --session <id|路径>   --no-llm   --dry-run
             --force(重跑已处理过的)   --limit N   --model <名>   --host claude-code|codex
  save       用你自己的话说一遍,把它认下来 —— **这一步才算数**
             --id <id> --my-words "……"  |  --file <路径>  |  --stdin
             --confirm    --list(看待补的)
  report     没有可读会话的宿主(WorkBuddy / Cursor)自己上报卡片,JSON 走 stdin 或 --file
             {"title","type","why","evidence":[],"ai","transfer","tags":[]}  或其数组
             --host workbuddy(默认)  --session <名>  --cwd <项目>  --dry-run
  kb         看你的知识库
             <关键词>  |  --list  --stale  --due  --inbox
             --show <id>   --confirm <id>   --json
             --reviewed <id> --recall <稳了|模糊|没想起来>   记一次复习,并排下次
  brain      选脑子 / 看花费 / 量固定开销
             status  |  enable <名> --yes  |  disable  |  bench --yes
  digest     这一周的汇总。**不调模型** —— 只把库里已有的东西按周摆好
             --days N   --since <日期>  --until <日期>   --dry-run
  rule       把确认过的卡回写进项目的 CLAUDE.md / AGENTS.md
             propose [--cwd <项目>]        从卡里挑规则,写进 inbox/rules-<日期>.md
             apply --cwd <项目> [--check]  写进项目文件(默认只预演,--yes 才动)
             uninstall --cwd <项目>        撤回(默认只预演)
             --self-test                   幂等断言,不碰任何文件
  doctor     全局自检:宿主注入 / hook / 脑 / 知识库 / 脱敏抽查
  install    装插件 / 卸载 / 自检 / 安排每周汇总(默认都只预演)
             --claude-code [--yes]        装插件
             --codex [--yes]              装 skill 到 ~/.codex/skills/(--uninstall 一起用即卸)
             --workbuddy [--yes]          装 skill 到 ~/.workbuddy/skills/(同上)
             --cursor [--yes]             装 skill 到 ~/.cursor/skills/(同上)
             --uninstall [--yes]          卸插件(周期任务一起撤)
             --schedule [--check] [--yes] 写 LaunchAgent:每周一 09:00 跑 digest
             --unschedule [--yes]         只撤周期任务
             --self-test                  插件完整性断言,不碰宿主
             --weekday 1-7 --hour 0-23 --minute 0-59   定时(只在 --schedule 时)
             --run-now                    装完立刻跑一次,用来确认它真的跑得起来
             --bin <路径> --node <路径>    指脚本与运行时(默认自动取绝对路径)

通用选项:
  --kb <目录>      知识库位置(默认 ~/knowledge,也可用 COACH_KB)
  --help           这份说明

关于「脑」:默认不调任何模型(--brain none),只产骨架卡。
要让它补「为什么」,先跑 coach brain enable claude --yes ——
那意味着会话内容会离开本机(走你配置里的自定义端点,不是 Anthropic 官方)。
`

const COMMANDS = new Set(['review', 'distill', 'save', 'kb', 'brain', 'digest', 'rule', 'doctor', 'install', 'report'])

async function main(argv: string[]): Promise<number> {
  const first = argv[0]

  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    process.stdout.write(USAGE)
    return first === undefined ? 2 : 0
  }
  if (first === '--version' || first === '-v') {
    process.stdout.write('coach 0.4.0\n')
    return 0
  }
  if (!COMMANDS.has(first)) {
    process.stderr.write(`✗ 不认识命令「${first}」。跑 coach --help 看看。\n`)
    return 2
  }

  const args = new Args(argv.slice(1))
  if (args.bool('help')) {
    process.stdout.write(USAGE)
    return 0
  }

  // 按需加载:review/distill 会拖进解析器和 prompts,
  // 而 `coach kb` 只想读几个 md 文件 —— 别让前者拖慢后者。
  switch (first) {
    case 'review': {
      const { runReview } = await import('./commands/review.ts')
      return runReview(makeCtx(args))
    }
    case 'distill': {
      const { runDistill } = await import('./commands/distill.ts')
      return runDistill(makeCtx(args))
    }
    case 'save': {
      const { runSave } = await import('./commands/save.ts')
      return runSave(makeCtx(args))
    }
    case 'kb': {
      const { runKb } = await import('./commands/kb.ts')
      return runKb(makeCtx(args))
    }
    case 'brain': {
      const { runBrain } = await import('./commands/brain.ts')
      return runBrain(makeCtx(args))
    }
    case 'digest': {
      const { runDigest } = await import('./commands/digest.ts')
      return runDigest(makeCtx(args))
    }
    case 'rule': {
      const { runRule } = await import('./commands/rule.ts')
      return runRule(makeCtx(args))
    }
    case 'doctor': {
      const { runDoctor } = await import('./commands/doctor.ts')
      return runDoctor(makeCtx(args))
    }
    case 'report': {
      const { runReport } = await import('./commands/report.ts')
      return runReport(makeCtx(args))
    }
    case 'install': {
      const { runInstall } = await import('./commands/install.ts')
      return runInstall(makeCtx(args))
    }
    default: {
      // COMMANDS 里列了但这里没有分支 —— 属于我们自己写漏了，
      // 所以要说清是「没实现」而不是装作成功。一个静默成功的 doctor
      // 会让用户以为检查过了。
      process.stderr.write(`✗ coach ${first} 没有实现。这是我们的疏漏。\n`)
      return 2
    }
  }
}

main(process.argv.slice(2))
  .then(code => {
    process.exitCode = code
  })
  .catch((err: unknown) => {
    // 栈要打到 stderr,但不能让它变成未捕获异常 —— hook 会拿到非零退出码
    // 而不知道该说什么。这里给一句话,细节留给 --debug。
    process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`)
    if (process.env['COACH_DEBUG'] === '1' && err instanceof Error && err.stack !== undefined) {
      process.stderr.write(err.stack + '\n')
    }
    process.exitCode = 1
  })
