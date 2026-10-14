// 一把基于 mkdir 的锁。
//
// 为什么需要：hook 只写 `state.hook`、digest 只写 `state.digest`，但两者都是
// 「读整个 state.json → 改一个字段 → 写回」。没有锁，后写的那个会把先写的
// 那个字段覆盖掉（典型的 read-modify-write 丢失更新）。
//
// 为什么是 mkdir 而不是 flock：POSIX 上 mkdir 是原子的，而且**不需要任何依赖**。
// 进程崩了会留下陈旧的锁目录，所以带 staleMs 抢占。

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LockHandle {
  release: () => void
}

export interface LockOptions {
  /** 等多久拿不到就放弃。热路径给 30ms，批处理给 2000ms。 */
  waitMs: number
  /** 超过这么久还活着的锁，视为持有者已死，抢占。 */
  staleMs?: number
}

function sleepSync(ms: number): void {
  // 同步睡。这些调用点本来就是同步的短临界区，用 Atomics.wait 比
  // 引入异步传染整条调用链便宜。
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

function isStale(dir: string, staleMs: number): boolean {
  try {
    const owner = JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')) as {
      pid?: number
      startedAt?: number
    }
    if (typeof owner.startedAt === 'number' && Date.now() - owner.startedAt > staleMs) return true
    if (typeof owner.pid === 'number') {
      try {
        process.kill(owner.pid, 0)
        return false // 进程还活着
      } catch {
        return true // ESRCH：持有者没了
      }
    }
  } catch {
    // owner.json 还没写完（创建目录与写文件之间有窗口）—— 按年龄判断
    return false
  }
  return false
}

export function acquire(kb: string, name: string, opts: LockOptions): LockHandle | null {
  const root = join(kb, '.coach', 'lock')
  const dir = join(root, name)
  const staleMs = opts.staleMs ?? 120_000
  const deadline = Date.now() + opts.waitMs

  for (;;) {
    try {
      mkdirSync(dir, { recursive: false })
      writeFileSync(
        join(dir, 'owner.json'),
        JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      )
      let released = false
      return {
        release: () => {
          if (released) return
          released = true
          try {
            rmSync(dir, { recursive: true, force: true })
          } catch {
            /* 幂等：已经没了就算了 */
          }
        },
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        mkdirSync(root, { recursive: true })
        continue // 父目录不存在，建好重来
      }
      if (isStale(dir, staleMs)) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          /* 别人也在抢，下一轮再说 */
        }
        continue
      }
      if (Date.now() >= deadline) return null
      sleepSync(10)
    }
  }
}

/** 拿不到就返回 null 的便捷包装：跑 fn，最后一定释放。 */
export function withLock<T>(
  kb: string,
  name: string,
  opts: LockOptions,
  fn: () => T,
): T | null {
  const handle = acquire(kb, name, opts)
  if (handle === null) return null
  try {
    return fn()
  } finally {
    handle.release()
  }
}
