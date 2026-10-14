// 按行流式读，带字节区间。
//
// 为什么不 `readFileSync` + `split('\n')`：本机最大的一个会话是
// **52 MB / 18,194 行**。整个读进来既慢又占内存，而 hook 那条热路径只允许
// 读尾部几百 KB。所以统一走流，两个调用点共用一套边界处理。

import { closeSync, createReadStream, openSync, readSync } from 'node:fs'
import { stat } from 'node:fs/promises'

/**
 * 只读文件**开头**这么多字节。
 *
 * 两个调用点（`sessions.ts` 读 cwd、`parse.ts` 读 header）都要「看开头几行」，
 * 而两处一开始都写成了 `readFileSync(path,'utf8').slice(0,N)` —— 那看着像
 * 只读 N 字节，其实**整个文件都进了内存**。本机有一场 52MB 的会话，
 * 而这两处恰好都在 hook 那条 <100ms 的热路径上：实测 `--latest` 因为这一行
 * 从 1.16s 掉到 0.11s。同一个坑踩了两次，所以并到这里只留一份实现。
 */
export function readHead(path: string, bytes = 64 * 1024): string {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.allocUnsafe(bytes)
    const got = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, got).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export interface LineChunk {
  line: string
  /** 1-based 行号。用 start 续读时，行号仍然是从文件头算起的真实行号。 */
  no: number
  bytes: number
}

export interface ReadLinesOptions {
  /** 起始字节偏移。>0 时会丢掉第一个不完整的行。 */
  start?: number
  /** 结束字节偏移（含）。省略即读到尾。 */
  end?: number
  /** 单行超过这么多字节就跳过 —— tool_result 里塞一整个文件的 base64 是常事。 */
  maxLineBytes?: number
  onSkip?: (bytes: number) => void
}

/**
 * 逐行产出。返回的行号是**从文件头算起**的真实行号，这样 `start` 续读时
 * 水位线和证据引用（`session:x#L88`）仍然对得上。
 */
export async function* readLines(
  path: string,
  opts: ReadLinesOptions = {},
): AsyncGenerator<LineChunk> {
  const { start = 0, end, maxLineBytes = 8 * 1024 * 1024, onSkip } = opts

  const stream = createReadStream(path, {
    start,
    ...(end === undefined ? {} : { end }),
    encoding: 'utf8',
    highWaterMark: 1 << 20,
  })

  let buf = ''
  // 从文件头算起的行号：start>0 时，我们已经站在若干行的中间，
  // 第一段碎片属于第 N 行的一部分，行号从「前面有多少个换行」是数不出来的 ——
  // 所以调用方要用 fromLine 时，我们把 no 标记为 -1（未知），由调用方决定。
  let lineNo = start === 0 ? 1 : 0
  let first = true

  for await (const chunk of stream) {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      let line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)

      if (first && start > 0) {
        // 起始偏移落在行中间：这段碎片是残缺的，丢掉
        first = false
        continue
      }
      first = false

      if (line.length > maxLineBytes) {
        onSkip?.(line.length)
        lineNo += 1
        continue
      }
      if (lineNo >= 1) yield { line, no: lineNo, bytes: line.length }
      lineNo += 1
    }
  }

  if (buf.length > 0 && !(first && start > 0)) {
    if (lineNo >= 1) yield { line: buf, no: lineNo, bytes: buf.length }
  }
}

/** 只读文件尾部这么多字节，返回行数组（不带行号）。hook 热路径用。 */
export async function readTail(path: string, bytes: number): Promise<string[]> {
  const st = await stat(path)
  const from = Math.max(0, st.size - bytes)
  const out: string[] = []
  for await (const { line } of readLines(path, { start: from })) out.push(line)
  return out
}
