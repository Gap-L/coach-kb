// 不调 LLM 的脑子。
//
// 它不是一个「降级占位」—— 它是**默认值**，也是所有其他脑子失败时的落点。
// 两种场景下它就是正确答案：
//
//   · `--no-llm`：使用者要求全程离线（知识库里全是工作内容，不该外发）
//   · 脑子挂了：超时、非 JSON、CLI 不在 PATH 里
//
// 关键在于它**产出的是完整的候选清单**：标题、类型、证据、触发原因全都在。
// 缺的只有「为什么」和「下一步」两段散文，那是可以日后补的。
// 于是「模型不可用」这件事的代价，从「这次会话白跑了」降到「这几张卡先空着」。
//
// 这正是旧 coach 的反面：它的失败是静默的丢数据，这里的失败是显式的缺两段。

import type { Brain, BrainOptions, BrainResult, DistillInput } from './types.ts'

export const noneBrain: Brain = {
  name: 'none',

  async probe(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: '不需要任何外部依赖' }
  },

  async distill(input: DistillInput, _opts: BrainOptions): Promise<BrainResult> {
    return {
      brain: 'none',
      drafts: input.candidates.map(c => ({ index: c.index, ai: '', transfer: '' })),
    }
  },
}
