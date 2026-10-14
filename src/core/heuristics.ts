// 分类器 —— 从旧 coach 逐字移植。
//
// 出处：~/.claude/dev-mods/91878ba0-b090-4f9d-a0d8-3a36ebeb059d/coach/hooks/logic.ts
// 那套阈值是踩出来的，注释里记着踩坑的原因。**改之前先读注释**：
//   · ASSENT_RE 在两个阶段语义相反（「开始吧」在 A 阶段是拒绝、B 阶段是同意），
//     曾经把它并进 REFUSE_RE，于是 B 阶段一句「可以，开始吧」被记成跳过，
//     连说两次把整个教练模式关掉了。
//   · isSkip 只在话很短时才算跳过，否则一句正经判断里带「开始」两个字就被
//     判成「他不想玩」。
//   · worthCoaching 刻意保守：漏判的代价是少教一次，误判的代价是用户关掉它。

export type CoachLevel = 'off' | 'lite' | 'full'
export type CoachPhase = 'idle' | 'ask' | 'contrast' | 'execute'

export function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length <= n ? one : one.slice(0, n - 1) + '…'
}

/**
 * 真·不想被教练。任何阶段命中都算跳过。
 * 这里只收「他不想说判断」的话 —— 别把「让他动手」的话混进来。
 */
export const REFUSE_RE =
  /跳过|别问了|别问|不用问|直接做|直接改|直接开始|少废话|别废话|不用了|不需要/

/**
 * 「让它动手」的话。**只在 A 阶段**算跳过 —— 那是「还没说出判断」的阶段，
 * 一句短促的「开始吧」就是「别问了，我不打算参与」。
 */
export const ASSENT_RE = /开始吧|动手吧|干吧|来吧|开始|动手|可以了|行了/

export function isSkip(text: string, phase: CoachPhase | null): boolean {
  if (REFUSE_RE.test(text)) return true
  return phase === 'ask' && text.length <= 12 && ASSENT_RE.test(text)
}

/** 用户第一句话里已经说了做法 —— 教练是多余的。 */
export const ALREADY_STATED_RE =
  /我打算|我想先|我准备|准备先|计划是|我的思路|第一步|先改|先看|先做|先查/

/** 一眼就是重活。 */
export const HEAVY_RE =
  /为什么|为何|如何|设计|优化|重构|排查|分析|调研|评估|方案|架构|实现|升级|迁移|梳理|统一|帮我改|帮我加|帮我做|帮我写|帮我重构|帮我看看/

/** 一眼就是琐事。 */
export const TRIVIAL_RE =
  /typo|错别字|格式化|空格|缩进|改个名|重命名|挪一下|跑一下|执行一下|删掉这行|去掉这行/

/** 复盘第四行的标记。 */
export const DEBRIEF_RE = /下次[^\n]{0,12}先看什么/

/**
 * 是否值得教练。刻意保守 —— 漏判的代价是少教一次，误判的代价是用户关掉它。
 */
export function worthCoaching(raw: string): boolean {
  const t = raw.trim()
  if (t.length === 0 || t.startsWith('/')) return false
  if (t.length <= 40 && TRIVIAL_RE.test(t)) return false
  if (ALREADY_STATED_RE.test(t)) return false

  let score = 0
  if (t.length >= 80) score += 2
  if (HEAVY_RE.test(t)) score += 2
  if ((t.match(/[\w./-]+\.[a-z]{1,5}\b/gi) ?? []).length >= 2) score += 1
  if (/[?？]/.test(t)) score += 1
  if (t.length <= 24) score -= 2
  return score >= 2
}

/**
 * 用户纠正 AI。这是本项目里**最值钱**的一类信号 —— 用户开口纠正的那一刻，
 * 就是他自己的判断和 AI 的判断分叉的地方，也正是知识卡片该记的东西。
 *
 * 比旧 coach 宽一些：「你又」「我没让你」这类带情绪的表达，往往对应最深的坑。
 */
export const CORRECTION_RE =
  /不对|不是这样|不是这个|我说的是|我说过|你又|我没让|没让你|别改|不要改|谁让你|搞错|弄错|理解错|错了|重新来|重来一次/

/** 用户明确表示「学到了」。他自己认证过的，置信度最高。 */
export const LEARNED_RE = /原来如此|学到了|明白了|这下懂了|记住|涨知识|原来是|恍然大悟|受教/

/**
 * 用户说自己没懂。这是概念类卡点 —— 没有报错、没改文件，只有一句「没明白」。
 * 这时最省事的是直接讲答案，也正是最不该做的：讲完他点头，下次照样不会。
 */
export const CONFUSED_RE =
  /没懂|不懂|没明白|不明白|看不懂|搞不懂|没看懂|什么意思|啥意思|为啥会|为什么会这样|怎么回事|还是不理解|不太理解/

/** 会改文件的 shell 命令。黑名单而不是白名单 —— 判不准就放行。 */
export const MUTATING_SH_RE =
  /\b(rm|rmdir|mv|cp|mkdir|touch|tee|truncate|dd|ln|chmod|chown|kill|pkill)\b|\s>>?\s*[^\s&|]|\bsed\s+-i|\bgit\s+(add|commit|push|checkout|reset|rebase|merge|stash|apply|clean)\b|\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall)\b|\bpip3?\s+install\b|\bcurl\b[^\n]*\s-o\b/

export const GATED_TOOLS = ['Write', 'Edit', 'NotebookEdit', 'MultiEdit'] as const
