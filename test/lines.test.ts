// readHead 的正确性很容易"看起来对"—— 整文件读再 slice 也返回同样的字符串。
// 所以这个文件里最重要的是**开销**那条断言：它盯的不是返回值,是读了几个字节。
// 本机最大的会话 52MB,而这函数在 hook 的 <100ms 路径上,读错一处分寸就全完了。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readHead } from '../src/core/lines.ts'
import { readCwd } from '../src/core/sessions.ts'

/** 仓库根 —— 从测试文件自己的位置往上走,不依赖 cwd 是哪儿。 */
const ROOT = join(dirname(new URL(import.meta.url).pathname), '..')

let DIR = ''
beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), 'coach-lines-'))
})
afterEach(() => {
  rmSync(DIR, { recursive: true, force: true })
})

function write(name: string, body: string): string {
  const p = join(DIR, name)
  writeFileSync(p, body)
  return p
}

describe('readHead', () => {
  test('短文件整个读回来', () => {
    const p = write('a.jsonl', '{"cwd":"/x"}\n')
    expect(readHead(p)).toBe('{"cwd":"/x"}\n')
  })

  test('长文件只读开头那一段', () => {
    const p = write('b.jsonl', 'A'.repeat(5000) + 'B'.repeat(5000))
    const head = readHead(p, 1024)
    expect(head).toHaveLength(1024)
    expect(head).toBe('A'.repeat(1024))
  })

  test('读不到就返回空串，不抛', () => {
    expect(readHead(join(DIR, '不存在.jsonl'))).toBe('')
  })

  // ★ 这条是给那个 bug 立的碑。
  //
  // `readFileSync(p,'utf8').slice(0,N)` 的返回值和这里**一模一样** ——
  // 所以任何盯着返回值的断言都抓不住它,而它把整个文件读进了内存。
  // 同一个坑在本项目里踩了两次(sessions.ts 的 readCwd、parse.ts 的 readHeader),
  // 两次都是「看起来只读了 N 字节」。
  //
  // 断言的是 **rss 增量**,不是 heapUsed —— 这条踩过坑:Bun 里字符串和 Buffer
  // 不计入 heapUsed,实测同一个 32MB 全量读 heapUsed 涨 0.0MB、rss 涨 32.5MB。
  // 拿 heap 去断言等于什么都没测。
  test('32MB 的文件也只读开头那一段（回归：不许整文件读）', () => {
    const MB = 1024 * 1024
    const big = join(DIR, 'big.jsonl')
    writeFileSync(big, 'x'.repeat(32 * MB))

    // 热身:第一次调用要把 Buffer 池、模块加载、JIT 都拉起来,
    // 那些开销与「读了多少字节」无关,不热身会算进下面的差值里。
    readHead(big, 4096)
    readHead(big, 4096)

    const before = process.memoryUsage().rss
    for (let i = 0; i < 8; i++) readHead(big, 4096)
    const delta = process.memoryUsage().rss - before

    // 正确实现实测 +0.4MB(8 次 × 64KB 的 Buffer);退化成整文件读是 +32MB 量级。
    // 4MB 落在中间,隔着一个数量级 —— 既不会放过回归,也不受 GC 时机影响。
    expect(delta).toBeLessThan(4 * MB)
    // 顺带确认它真的用了调用方给的上限,而不是"恰好没读完"
    expect(readHead(big, 4096)).toHaveLength(4096)
  })
})

// ---------------------------------------------------------------------------
// 源码级护栏
// ---------------------------------------------------------------------------

/**
 * 这条不是测函数,是**测源码里不再出现那个惯用法**。
 *
 * 上面那条 rss 断言只保护 `readHead` 自己。真正的风险是有人在新地方又写下
 * `readFileSync(p,'utf8').slice(0,N)` —— 它在一个 50MB 的文件上、又恰好在
 * hook 的路径上时,表现是「某次回车卡了 3 秒」,没人会联想到这一行。
 * 所以在这里把那个形状本身禁掉。
 *
 * 注释先剥掉再匹配 —— lines.ts 的文档注释里就写着这个反例(它正是在解释
 * 为什么要用 readHead),不剥的话这条测试会指着那段说明说它违规。
 * 剥注释用的是朴素规则(`//` 到行尾、`/*…*​/`),字符串字面量里出现 `//`
 * 会被误剥 —— 对这个检查来说可以接受:误剥只会让检查更松,不会误报。
 */
describe('源码里不许再出现「整文件读再截断」', () => {
  test('src/ 下没有任何 readFile(...).slice(', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          walk(p)
          continue
        }
        if (!e.name.endsWith('.ts')) continue
        const code = readFileSync(p, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
          .replace(/\/\/[^\n]*/g, '') // 行注释
        // readFileSync(...)/readFile(...) 之后紧跟 .slice( —— 就是那个形状。
        // 中间允许跨行,所以不限制 [^)]* 里有没有换行,但要求不嵌套括号
        // （够用了:真出现 readFile(join(a,b)) 时外层仍然是 .slice(）。
        if (/readFile(?:Sync)?\s*\([^()]*\)\s*\.slice\s*\(/.test(code)) {
          offenders.push(p.replace(ROOT + '/', ''))
        }
      }
    }
    walk(join(ROOT, 'src'))
    expect(offenders).toEqual([])
  })
})

describe('readCwd 走的是同一份实现', () => {
  const row = (cwd: string): string => JSON.stringify({ type: 'user', cwd, message: 'hi' })

  test('从头部第一行拿到 cwd', () => {
    const p = write('s.jsonl', [row('/Users/lingaibo/workspace'), '{}'].join('\n'))
    expect(readCwd(p)).toBe('/Users/lingaibo/workspace')
  })

  // 头部可能有坏行（半行、非 JSON）—— 不能因此丢掉整个 cwd。
  test('跳过坏行继续找', () => {
    const p = write('s.jsonl', ['{"type":"sum', 'not json at all', row('/tmp/repo')].join('\n'))
    expect(readCwd(p)).toBe('/tmp/repo')
  })

  test('没有 cwd 字段就返回空串', () => {
    expect(readCwd(write('s.jsonl', '{"type":"user"}'))).toBe('')
  })

  // 反解目录名是不可靠的（/a/b 和 /a-b 的 slug 一样），所以 cwd 必须来自文件内容。
  // 这条盯的是"别退回去猜目录名"。
  test('cwd 只认文件内容,不认文件名', () => {
    const p = write('-Users-lingaibo-workspace.jsonl', row('/somewhere/else'))
    expect(readCwd(p)).toBe('/somewhere/else')
  })
})
