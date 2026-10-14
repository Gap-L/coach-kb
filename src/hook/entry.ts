#!/usr/bin/env node
// UserPromptSubmit hook 的进程入口。**只有这些行。**
//
// 全部逻辑在 `./nudge.ts` —— 分开是因为这个文件一旦被 import 就会跑起来,
// 而 `runHook()` 会去读标准输入,在没有 stdin 的进程里那是永久阻塞。
// 把"会执行"这件事收在一个 20 行的文件里,别的东西就都能安全地被 import。
//
// 三条纪律,每一条都对应一个具体的坏结果:
//   1. 异常全吞       —— 它失败的唯一可接受表现是"什么都没发生"
//   2. 永远 exit 0    —— exit 2 会**把用户的 prompt 拦下来不发**,那是灾难
//   3. writeSync 输出 —— process.stdout.write 对管道是异步的,紧接着的
//                        process.exit 会把没 flush 的内容丢掉,提醒时有时无

import { runHook } from './nudge.ts'

runHook()
  .catch((err: unknown) => {
    // 静默 —— 但**留一个出口**。整个项目的立身之本是"失败不许静默"
    // (旧 coach 的笔记目录一直是空的,而没有任何地方报错过)。hook 这条
    // 路径上静默是必须的(它挡不住用户的 prompt),所以代价是:一旦它坏了,
    // 表现就是"再也不提醒了",而那和"这周确实没什么可提醒的"长得一模一样。
    // 所以给一个开关让你能看见它:
    //     COACH_DEBUG=1 claude          ← 每次回车都会打出下面这行
    if (process.env['COACH_DEBUG'] === '1') {
      process.stderr.write(`[coach-kb] hook 出错(已静默): ${err instanceof Error ? err.message : String(err)}\n`)
    }
  })
  .finally(() => {
    process.exit(0)
  })
