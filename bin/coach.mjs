#!/usr/bin/env node
// 薄壳。真正的实现是 dist/coach.mjs（bun build 的产物）。
// 单独留一个 bin/ 是为了插件与 skill 能引用一个**稳定**的路径 ——
// dist 会随构建换内容，bin/coach.mjs 不会。
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 仓根 dist/ 不入 git(见 .gitignore),入 git 的是 plugin/dist/ 那份同样的 bundle。
// 所以刚 clone 下来、没装 Bun 的同事走第二个 —— 不该让他们为了跑 CLI 先装构建工具。
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dist = [join(root, 'dist', 'coach.mjs'), join(root, 'plugin', 'dist', 'coach.mjs')].find(p => existsSync(p))
if (dist === undefined) {
  console.error(`还没构建:缺少 ${join(root, 'dist', 'coach.mjs')}\n先跑一次:bun run build`)
  process.exit(1)
}
await import(dist)
