// 手写参数解析。零依赖。
//
// 只用得到四种形态，够用就别引 minimist:
//   --flag            布尔
//   --key value       取值
//   --key=value       取值(等号写法)
//   --no-llm          布尔(否定式，值就是 false)
//
// ★ 一条刻意的取舍:**不认 `-` 开头的短选项**。省下来的复杂度花在
//   「`--kb` 后面跟的那个值到底是值还是下一个 flag」这种真正的坑上:
//   只有当下一个 token 不以 `-` 开头、且不是已知旗标的取值时,才算作值。

export class Args {
  private readonly flags = new Map<string, string | boolean>()
  readonly positional: string[] = []

  constructor(argv: string[]) {
    for (let i = 0; i < argv.length; i += 1) {
      const tok = argv[i] as string
      if (!tok.startsWith('--')) {
        this.positional.push(tok)
        continue
      }
      const eq = tok.indexOf('=')
      if (eq !== -1) {
        this.flags.set(tok.slice(2, eq), tok.slice(eq + 1))
        continue
      }
      const name = tok.slice(2)
      if (name.startsWith('no-')) {
        // `--no-llm` 记成 `llm=false`:调用方写 `args.bool('llm', true)`,
        // 否定式与肯定式合用一个名字,不用两套查询。
        this.flags.set(name.slice(3), false)
        continue
      }
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        this.flags.set(name, next)
        i += 1
        continue
      }
      this.flags.set(name, true)
    }
  }

  has(name: string): boolean {
    return this.flags.has(name) && this.flags.get(name) !== false
  }

  /** 取值。给 `true`(裸旗标)时返回 fallback —— 裸旗标没有值。 */
  get(name: string, fallback?: string): string | undefined {
    const v = this.flags.get(name)
    if (v === undefined || v === true || v === false) return fallback
    return v
  }

  bool(name: string, fallback = false): boolean {
    const v = this.flags.get(name)
    if (v === undefined) return fallback
    return v !== false
  }

  num(name: string, fallback: number): number {
    const raw = this.get(name)
    if (raw === undefined) return fallback
    const n = Number(raw)
    return Number.isFinite(n) ? n : fallback
  }

  /** 显式给过这个名字吗(不管值是什么)。`--no-llm` 也算给过。 */
  given(name: string): boolean {
    return this.flags.has(name)
  }
}
