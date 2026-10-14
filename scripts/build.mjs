#!/usr/bin/env bun
// 两个产物,不是一个 —— 因为它们的性能预算差一个数量级:
//
//   dist/coach.mjs  全量 CLI。进得了 brain、kb、install,冷启动慢无所谓。
//   dist/hook.mjs   挂在 UserPromptSubmit 上的热路径。**必须**只含
//                   guard + 尾部解析 + 一张正则表 —— 任何一次
//                   `import { kb }` 都会把整个知识库模块拖进 bundle,
//                   冷启动从 ~40ms 涨到 ~200ms,每次回车都能感觉到。
//
// 两个都显式写 --target=node 与 --format=esm,不赌默认值。

import { build } from 'bun'
import { rm, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist')

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

const CORE = ['node:*']

async function bundle(entry, name) {
  // 产物还没写出来时**明说跳过**,不要静默通过 —— 一个"构建成功"但
  // 缺了 hook.mjs 的 dist/ 会让 hook 每次回车都悄悄失败。
  if (!(await Bun.file(join(root, entry)).exists())) {
    console.log(`  ${name}  跳过(${entry} 还没写)`)
    return true
  }
  const result = await build({
    entrypoints: [join(root, entry)],
    outdir: out,
    naming: name,
    target: 'node',
    format: 'esm',
    external: CORE,
    minify: true,
    sourcemap: 'linked',
    define: { 'process.env.COACH_BUILD': JSON.stringify(new Date().toISOString()) },
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exitCode = 1
    return false
  }
  const bytes = (await Bun.file(join(out, name)).arrayBuffer()).byteLength
  console.log(`  ${name}  ${(bytes / 1024).toFixed(1)} KB`)
  return true
}

console.log('构建:')
const ok = (await bundle('src/cli.ts', 'coach.mjs')) && (await bundle('src/hook/entry.ts', 'hook.mjs'))
if (!ok) process.exit(1)

// ★ 产物必须**同时**在 plugin/ 里放一份。
//
// hook 命令只能写 ${CLAUDE_PLUGIN_ROOT}/…,而 ${CLAUDE_PLUGIN_ROOT} 在
// 从 git/url/npm 装的插件上指向**缓存副本**,不是这个仓:
//   · 路径里带 `..` 会被 `claude plugin validate` 直接判为路径穿越
//   · 即使本地路径装(就地加载)侥幸能读到 ../dist,同一个插件被同事从
//     git 装上时就会静默失效 —— 这正是一个"装好了但不生效"的坑
// 所以把 bundle 复制进 plugin/dist/,让插件自包含。仓根的 dist/ 保留,
// 因为验收命令和 bin/coach.mjs 都指着它。
const pluginDist = join(root, 'plugin', 'dist')
await mkdir(pluginDist, { recursive: true })
for (const name of ['coach.mjs', 'hook.mjs']) {
  const from = Bun.file(join(out, name))
  if (!(await from.exists())) continue
  await Bun.write(join(pluginDist, name), from)
}
console.log(`  → plugin/dist/  已同步(插件必须自包含,见 build.mjs 里的说明)`)
console.log('完成。')

