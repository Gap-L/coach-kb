// 插件目录在哪。
//
// 两种跑法都要认,因为 install 与 doctor 会在两种环境下被调用:
//   仓里跑    node dist/coach.mjs doctor          → dist/../plugin
//   插件里跑  node plugin/dist/coach.mjs doctor   → dist/..
//
// 这个函数不需要知道仓库在哪 —— 它只从「我自己这个脚本在哪个目录」往回看。
// 硬编码仓库路径是不行的:插件从 git 装到同事机器上时,${CLAUDE_PLUGIN_ROOT}
// 指向的是缓存副本,那个路径在这台机器上根本不存在。

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 环境变量优先 —— 测试和 `--plugin-dir` 试跑时用得上。 */
export function pluginDir(): string | null {
  const env = process.env['COACH_PLUGIN_DIR']
  if (env !== undefined && existsSync(join(env, '.claude-plugin', 'plugin.json'))) return env

  const entry = process.argv[1]
  if (entry !== undefined) {
    const here = dirname(entry)
    for (const cand of [join(here, '..', 'plugin'), join(here, '..')]) {
      if (existsSync(join(cand, '.claude-plugin', 'plugin.json'))) return cand
    }
  }
  return null
}
