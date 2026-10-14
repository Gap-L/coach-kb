import { describe, expect, test } from 'bun:test'
import { Args } from '../src/args.ts'

describe('Args', () => {
  test('布尔旗标', () => {
    const a = new Args(['--latest', '--force'])
    expect(a.bool('latest')).toBe(true)
    expect(a.bool('force')).toBe(true)
    expect(a.bool('nope')).toBe(false)
    expect(a.bool('nope', true)).toBe(true)
  })

  test('取值：空格写法与等号写法等价', () => {
    expect(new Args(['--kb', '/tmp/x']).get('kb')).toBe('/tmp/x')
    expect(new Args(['--kb=/tmp/x']).get('kb')).toBe('/tmp/x')
  })

  // 计划里所有命令都靠 `--kb` 指到临时目录；一旦它把下一个旗标吃成值，
  // 命令就会往一个叫 "--no-llm" 的目录里写东西。
  test('旗标后面紧跟另一个旗标时，不吃成值', () => {
    const a = new Args(['--kb', '--no-llm'])
    expect(a.get('kb')).toBeUndefined()
    expect(a.bool('kb')).toBe(true)
    expect(a.bool('llm')).toBe(false)
  })

  test('--no-X 记成 X=false，与肯定式共用一个名字', () => {
    const a = new Args(['--no-llm'])
    expect(a.bool('llm')).toBe(false)
    expect(a.bool('llm', true)).toBe(false)
    expect(a.given('llm')).toBe(true)
  })

  test('没给过 llm 时，given 为 false —— 命令靠它区分「明说关掉」和「没说」', () => {
    expect(new Args([]).given('llm')).toBe(false)
    expect(new Args(['--llm']).given('llm')).toBe(true)
  })

  test('位置参数按顺序收集', () => {
    expect(new Args(['kb', '鉴权', '--json']).positional).toEqual(['kb', '鉴权'])
  })

  test('num 解析，坏值退回默认', () => {
    expect(new Args(['--limit', '7']).num('limit', 40)).toBe(7)
    expect(new Args(['--limit', 'abc']).num('limit', 40)).toBe(40)
    expect(new Args([]).num('limit', 40)).toBe(40)
  })

  // 一段中文里带空格是常事（save --my-words "我原来以为 X"），
  // 但用户也可能忘了加引号。拿不到就是拿不到，不能猜。
  test('裸旗标上 get 返回 fallback', () => {
    expect(new Args(['--json']).get('json')).toBeUndefined()
    expect(new Args(['--json']).get('json', 'x')).toBe('x')
  })

  test('带空格的值整体保留', () => {
    expect(new Args(['--my-words', '我原来以为这样']).get('my-words')).toBe('我原来以为这样')
  })

  test('get 拿不到真值时不返回布尔 —— 免得 String(true) 流进文件名', () => {
    const a = new Args(['--kb'])
    expect(typeof a.get('kb')).not.toBe('boolean')
  })

  test('中文取值当得上值:--reviewed <id> --recall 稳了', () => {
    const a = new Args(['--reviewed', 'kb-x', '--recall', '稳了'])
    expect(a.get('reviewed')).toBe('kb-x')
    expect(a.get('recall')).toBe('稳了')
  })

  // ★ 裸 `--reviewed` 时 get() 是 undefined，所以命令层必须用 given() 判断 ——
  //   否则它拿不到 id，会静默掉进 `kb` 的关键词搜索分支，
  //   对着一句空话打「没有匹配「」的卡」。
  test('裸旗标上 given 为真、get 为 undefined', () => {
    const a = new Args(['--reviewed'])
    expect(a.given('reviewed')).toBe(true)
    expect(a.get('reviewed')).toBeUndefined()
  })
})
