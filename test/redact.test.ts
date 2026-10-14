import { describe, expect, test } from 'bun:test'
import { redactText, safeForCard, scanRedaction } from '../src/core/redact.ts'

// 每个用例都用**拼接**造串，避免这个测试文件本身成为一个能被扫到的密钥文件。
const fake = (...parts: string[]): string => parts.join('')

describe('必须被遮罩的', () => {
  const CASES: Array<[string, string]> = [
    ['Anthropic key', fake('sk-', 'ant-api03-', 'AbCdEf0123456789AbCdEf0123456789')],
    ['GitHub PAT (classic)', fake('ghp', '_', 'AbCdEf0123456789AbCdEf0123456789AbCd')],
    ['GitHub PAT (fine-grained)', fake('github', '_pat_', '11ABCDEFG0abcdefghijklmnopqrstuv')],
    // 刻意避开 AWS 文档里那个 `…7EXAMPLE` —— 它含 "EXAMPLE"，会被白名单
    // 当成夹具放行（这是白名单的设计意图，见另一组测试）
    ['AWS access key', fake('AKIA', 'J7QX2M4NPZR6WY3D')],
    ['Slack bot token', fake('xoxb', '-123456789012-', 'abcdefghijklmnop')],
    ['Bearer', fake('Authorization: Bearer ', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')],
    ['env 赋值式密钥', fake('ANTHROPIC_AUTH_TOKEN', '=', 'zzz-secret-value')],
    ['连接串密码', fake('postgres://admin:', 'hunter2hunter2', '@db.internal:5432/app')],
  ]

  for (const [name, raw] of CASES) {
    test(name, () => {
      const { text, hits } = redactText(raw)
      expect(hits.length).toBeGreaterThan(0)
      expect(text).not.toContain(raw)
    })
  }

  test('私钥块整段消失', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyz',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n')
    const { text } = redactText(`key:\n${pem}\n`)
    expect(text).not.toContain('MIIEowIBAAKCAQEA')
    expect(text).not.toContain('BEGIN RSA PRIVATE KEY')
  })

  test('变量名保留下来，仍然读得懂', () => {
    const { text } = redactText(fake('ANTHROPIC_AUTH_TOKEN', '=', 'zzz-secret-value'))
    expect(text).toContain('ANTHROPIC_AUTH_TOKEN')
  })
})

describe('不许误伤的', () => {
  const KEEP = [
    'src/adapters/claude-code/parse.ts',
    'https://api.example.com/v1/messages',
    'aebd09c8-1c1e-4b62-9f0a-2f4a7c9d3e10',
    '3f7a1b9c2d4e5f60718293a4b5c6d7e8f9012345', // commit sha：纯十六进制，必须放过
    'pnpm install --frozen-lockfile',
    '记得把 TOKEN 换成环境变量',
    '明文的 key 不该进仓库',
  ]

  for (const s of KEEP) {
    test(s, () => {
      const { text, hits } = redactText(s)
      expect(text).toBe(s)
      expect(hits).toEqual([])
    })
  }

  test('路径不被当成高熵串', () => {
    const p = '/Users/lingaibo/workspace/coach-kb/src/adapters/claude-code/parse.ts'
    expect(redactText(p).text).toBe(p)
  })

  // 白名单是**刻意的**取舍：夹具与示例里的假密钥如果天天被遮罩，
  // 卡片就没法读了。代价是理论上会放过含 "example"/"test" 字样的真密钥 ——
  // 随机密钥里出现这几个词的概率可以忽略。把它钉在测试里，防止被「顺手删掉」。
  test('示例密钥被白名单放行（有意为之）', () => {
    const docKey = fake('AKIA', 'IOSFODNN7EXAMPLE')
    expect(redactText(docKey).text).toBe(docKey)
  })
})

describe('scanRedaction / safeForCard', () => {
  test('干净文本通过', () => {
    expect(scanRedaction('就是一句普通的话').ok).toBe(true)
  })

  test('漏网的会被抓住', () => {
    const leaked = fake('sk-', 'ant-api03-', 'AbCdEf0123456789AbCdEf0123456789')
    const scan = scanRedaction(leaked)
    expect(scan.ok).toBe(false)
    expect(scan.hits.length).toBeGreaterThan(0)
  })

  test('safeForCard：干净的原样返回，脏的遮罩并标记', () => {
    expect(safeForCard('普通文本')).toEqual({ text: '普通文本', masked: false })
    const dirty = safeForCard(fake('ghp', '_', 'AbCdEf0123456789AbCdEf0123456789AbCd'))
    expect(dirty.masked).toBe(true)
    expect(scanRedaction(dirty.text).ok).toBe(true)
  })
})

describe('幂等：洗过的文本再洗一遍不变', () => {
  test('二次脱敏是恒等变换', () => {
    const raw = `先 export ${fake('OPENAI_API_KEY', '=', 'sk-', 'proj-abcdefghijklmnopqrstuvwxyz')} 再跑`
    const once = redactText(raw).text
    expect(redactText(once).text).toBe(once)
  })
})
