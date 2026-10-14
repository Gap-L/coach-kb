// 脱敏。
//
// 会话里一定会出现密钥 —— 本机就有一例：`~/.codex/config.toml` 的
// `shell_environment_policy.set` 里明文存着 ANTHROPIC_AUTH_TOKEN，而那个文件
// 被读进过会话。而 IR 是要**发出去**的（喂给 headless CLI）。所以这里不是
// 「锦上添花」，是发车前必须踩的那一脚。
//
// 三层（调用点见各命令）：
//   L1 ingest  构造 IR 时逐字段过一遍 —— 主边界
//   L2 compose 拼好 prompt、spawn 之前再断言一次 —— 抓 L1 的漏
//   L3 write   卡片落盘前扫一遍 —— 模型可能从上下文「重构」出密钥
//
// 误伤的代价是卡片难读，漏放的代价是密钥外泄 —— 所以除了最后一条
// high_entropy，其余都是宁可错杀。high_entropy 单独用 SUSPECT 标记而不是
// 静默替换，因为真 commit sha 会被它误判，得让人看得见。

export interface RedactHit {
  name: string
  count: number
}

export interface RedactResult {
  text: string
  hits: RedactHit[]
  /** high_entropy 的命中数，单独计数 —— 它是唯一「可能误伤」的一条。 */
  suspects: number
}

interface Rule {
  name: string
  re: RegExp
  sub: string
}

/** 测试夹具与示例里的假密钥，明确放行。少了这条白名单会天天误伤。 */
const WHITELIST_RE =
  /(?:test|fake|dummy|sample|example|placeholder|xxx+|your[_-]?|redacted|«|\*\*\*)/i

const RULES: Rule[] = [
  {
    name: 'private_key',
    // 多行，必须排在所有单行规则之前 —— 否则块里的 base64 会被 high_entropy 逐行啃掉
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    sub: '«REDACTED:private_key»',
  },
  {
    name: 'api_key_sk',
    re: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    sub: '«REDACTED:api_key»',
  },
  {
    name: 'github_token',
    re: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/g,
    sub: '«REDACTED:github_token»',
  },
  {
    name: 'aws_key',
    re: /\b(?:AKIA|AKID|ASIA)[0-9A-Z]{12,}\b/g,
    sub: '«REDACTED:aws_key»',
  },
  {
    name: 'slack_token',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    sub: '«REDACTED:slack_token»',
  },
  {
    name: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    sub: '«REDACTED:jwt»',
  },
  {
    name: 'bearer',
    re: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
    sub: '«REDACTED:bearer»',
  },
  {
    name: 'auth_header',
    re: /\b(Authorization|X-Api-Key|X-Auth-Token|x-api-key)\b\s*[:=]\s*\S+/gi,
    sub: '$1: «REDACTED»',
  },
  {
    name: 'conn_string',
    // 只遮密码，保留 host/db —— 诊断问题时要靠它
    re: /\b(mysql|postgres|postgresql|mongodb\+srv|mongodb|redis|amqp|amqps):\/\/([^\s:@/]+):([^\s@/]+)@/gi,
    sub: '$1://$2:«REDACTED»@',
  },
  {
    name: 'env_assign_secret',
    // 保留变量名，只换值 —— 「这里有 ANTHROPIC_AUTH_TOKEN」本身是有效信息
    re: /^([ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*(?:_TOKEN|_KEY|_SECRET|_PASSWORD|_PASSWD|_AUTH))\s*=\s*(\S+)/gm,
    sub: '$1=«REDACTED»',
  },
  {
    name: 'named_secret',
    re: /\b(anthropic|openai|aws|azure|cohere|deepseek|dashscope|moonshot|zhipu|qwen)[A-Za-z0-9_-]*(?:_api_?key|_token|_secret|_auth)\b\s*[:=]\s*\S+/gi,
    sub: '«REDACTED:named_secret»',
  },
  {
    name: 'generic_assign',
    // 排在最后，避免吃掉上面那些更具体的规则
    re: /\b(password|passwd|pwd|secret|token|apikey|api_key|access_key)\b\s*[:=]\s*["']?([^\s"',;]{6,})/gi,
    sub: '$1=«REDACTED»',
  },
]

/**
 * 长度 28–96、三类字符齐全、熵够高 —— 才算可疑。
 *
 * 放过路径是第一要务：`Users/lingaibo/workspace/coach-kb/src/core/redact`
 * 这类串的熵和真密钥是同一量级，光看熵必然误伤。所以先按形状排除 ——
 * 含 `/` 的一律当路径放过；纯 hex 放过（commit sha）；缺大写/小写/数字
 * 任一类的放过（kebab-case 的目录名全落在这里）。
 */
function looksEntropic(word: string): boolean {
  if (word.length < 28 || word.length > 96) return false
  if (word.includes('/')) return false
  if (!/^[A-Za-z0-9+/=_-]+$/.test(word)) return false
  if (/^[0-9a-f]{32,64}$/i.test(word)) return false // commit sha / md5
  if (!/[A-Z]/.test(word) || !/[a-z]/.test(word) || !/[0-9]/.test(word)) return false
  return shannon(word) > 4.2
}

function shannon(s: string): number {
  const freq = new Map<string, number>()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of freq.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

export function redactText(input: string): RedactResult {
  let text = input
  const hits: RedactHit[] = []

  for (const rule of RULES) {
    let count = 0
    text = text.replace(rule.re, (...args) => {
      const match = args[0] as string
      // 假密钥白名单：只对「看起来像密钥」的规则放行，私钥块不放
      if (rule.name !== 'private_key' && WHITELIST_RE.test(match)) return match
      count += 1
      // 支持 $1 这类反向引用
      return rule.sub.replace(/\$(\d)/g, (_, d) => (args[Number(d)] as string) ?? '')
    })
    if (count > 0) hits.push({ name: rule.name, count })
  }

  // 最后一道：高熵串，只标记不替换
  let suspects = 0
  text = text.replace(/\b[A-Za-z0-9+/=_-]{28,96}\b/g, (word) => {
    if (!looksEntropic(word)) return word
    suspects += 1
    return '«SUSPECT:high_entropy»'
  })

  return { text, hits, suspects }
}

/** L2/L3 用：还有没有漏网的。ok=false 就说明 L1 有洞。 */
export function scanRedaction(text: string): { ok: boolean; hits: string[] } {
  const hits: string[] = []
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags)
    const found = text.match(re)
    if (found) {
      for (const one of found) {
        if (!WHITELIST_RE.test(one)) hits.push(`${rule.name}: ${one.slice(0, 40)}`)
      }
    }
  }
  return { ok: hits.length === 0, hits }
}

/** 把一段文本安全地放进卡片：先用 scanRedaction 看，再决定要不要就地遮罩。 */
export function safeForCard(text: string): { text: string; masked: boolean } {
  const { ok } = scanRedaction(text)
  if (ok) return { text, masked: false }
  return { text: redactText(text).text, masked: true }
}
