import { describe, expect, test } from 'bun:test'
import {
  ALREADY_STATED_RE,
  ASSENT_RE,
  CORRECTION_RE,
  DEBRIEF_RE,
  HEAVY_RE,
  LEARNED_RE,
  MUTATING_SH_RE,
  REFUSE_RE,
  clip,
  isSkip,
  worthCoaching,
} from '../src/core/heuristics.ts'

describe('isSkip —— 两个阶段的语义是反的', () => {
  test('真·不想被教练：任何阶段都算跳过', () => {
    for (const t of ['跳过', '别问了', '直接做', '少废话']) {
      expect(isSkip(t, 'ask')).toBe(true)
      expect(isSkip(t, 'contrast')).toBe(true)
      expect(isSkip(t, null)).toBe(true)
    }
  })

  test('★「开始吧」只在 A 阶段算跳过', () => {
    // 这是移植时踩过的坑：ASSENT_RE 曾经被并进 REFUSE_RE，于是 B 阶段一句
    // 「可以，开始吧」被记成跳过，连说两次把整个教练模式关掉了。
    expect(isSkip('开始吧', 'ask')).toBe(true)
    expect(isSkip('可以，开始吧', 'contrast')).toBe(false)
    expect(isSkip('开始吧', 'execute')).toBe(false)
    expect(isSkip('开始吧', null)).toBe(false)
  })

  test('话一长就不算跳过 —— 正经判断里带「开始」两个字不算不想玩', () => {
    const long = '我想先看一下现有的中间件是怎么挂的，然后再决定要不要开始重构那部分'
    expect(long.length).toBeGreaterThan(12)
    expect(ASSENT_RE.test(long)).toBe(true) // 确实命中关键词
    expect(isSkip(long, 'ask')).toBe(false) // 但不该判成跳过
  })

  test('REFUSE_RE 里不许混进「让他动手」的话', () => {
    // 两类词混在一起，就是上面那个 bug 的成因。这条断言把它钉住。
    for (const w of ['开始吧', '动手吧', '来吧', '行了']) {
      expect(REFUSE_RE.test(w)).toBe(false)
    }
  })
})

describe('worthCoaching —— 刻意保守', () => {
  test('空的与斜杠命令直接否', () => {
    expect(worthCoaching('')).toBe(false)
    expect(worthCoaching('   ')).toBe(false)
    expect(worthCoaching('/coach-kb:review')).toBe(false)
  })

  test('琐事否（短的才判，长的可能是正经需求）', () => {
    expect(worthCoaching('帮我改个错别字')).toBe(false)
    expect(worthCoaching('格式化一下')).toBe(false)
  })

  test('★ 已经说了做法的就不用再问', () => {
    // 教练要的是「让他说出判断」；他已经说了，再问一遍是折磨
    expect(worthCoaching('我打算先改 parse.ts 再处理适配层')).toBe(false)
    expect(ALREADY_STATED_RE.test('我的思路是先跑一遍看看')).toBe(true)
  })

  test('重活放行', () => {
    expect(worthCoaching('帮我重构一下鉴权那部分，中间件顺序好像不太对，你帮我看看')).toBe(true)
    expect(worthCoaching('为什么这个 hook 每次都要跑两遍，我看着不太对劲')).toBe(true)
  })

  test('短句不给分 —— 「看一下」这种不值得教练', () => {
    expect(worthCoaching('看一下这个')).toBe(false)
    expect(worthCoaching('跑一下试试')).toBe(false)
  })

  test('★ 24 字以下一律不教，哪怕命中重活特征 —— 25 字是条隐形门槛', () => {
    // 上面那句「为什么这个 hook 每次都要跑两遍？」只有 19 字：
    // 命中 HEAVY_RE(+2) 又带问号(+1)，看着该放行 ——
    // 但 −2 的短句惩罚把它压回 1 分，于是不教。
    const short = '为什么这个 hook 每次都要跑两遍？'
    expect(short.length).toBe(19)
    expect(HEAVY_RE.test(short)).toBe(true)
    expect(worthCoaching(short)).toBe(false)

    // 这条是从旧 coach 逐字搬来的（logic.ts:171），实测确实保守到会漏判。
    // 留着是因为：漏判的代价是少教一次，误判的代价是他把整个模式关掉。
    // 所以看到「够重了却不教」时别急着当成 bug —— 先把这句话读一遍。
    expect(worthCoaching('为什么这个 hook 每次都要跑两遍，我怀疑是缓存')).toBe(true)
  })

  test('提到两个以上文件名算加分项', () => {
    const withFiles = 'core/signals.ts 和 commands/distill.ts 这两处对不上，帮我看看'
    expect(worthCoaching(withFiles)).toBe(true)
  })
})

describe('clip', () => {
  test('压平空白再截', () => {
    expect(clip('a\n\n  b\tc', 40)).toBe('a b c')
  })

  test('超长留省略号，长度不超上限', () => {
    const out = clip('あ'.repeat(50), 10)
    expect(out.length).toBe(10)
    expect(out).toEndWith('…')
  })

  test('刚好等于上限时不截', () => {
    expect(clip('abcd', 4)).toBe('abcd')
  })
})

describe('几个正则的边界', () => {
  test('DEBRIEF_RE 认的是复盘第四行那句', () => {
    expect(DEBRIEF_RE.test('下次这类问题你可以先看什么：先跑 parse 的单测')).toBe(true)
    expect(DEBRIEF_RE.test('下次再看吧')).toBe(false)
  })

  test('CORRECTION_RE 收的是「你的判断和 AI 分叉」的那一刻', () => {
    for (const t of ['不对', '我说的是那个旧的', '你又改错了', '我没让你动这里']) {
      expect(CORRECTION_RE.test(t)).toBe(true)
    }
    expect(CORRECTION_RE.test('好的继续')).toBe(false)
  })

  test('LEARNED_RE 是用户自己认证的', () => {
    expect(LEARNED_RE.test('原来如此')).toBe(true)
    expect(LEARNED_RE.test('这下懂了')).toBe(true)
    expect(LEARNED_RE.test('嗯')).toBe(false)
  })

  test('MUTATING_SH_RE 是黑名单：会动的命令要抓得住', () => {
    for (const c of ['rm -rf build', 'git push --force', 'sed -i "" s/a/b/ f.ts', 'echo x > out.txt', 'npm install']) {
      expect(MUTATING_SH_RE.test(c)).toBe(true)
    }
  })

  test('MUTATING_SH_RE 不误伤只读命令 —— 判不准就放行', () => {
    for (const c of ['ls -la', 'git status', 'git diff HEAD', 'cat f.ts', 'bun test']) {
      expect(MUTATING_SH_RE.test(c)).toBe(false)
    }
  })
})
