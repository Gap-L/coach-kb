import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LABEL,
  defaultSpec,
  describeSchedule,
  launchdDomain,
  plistPath,
  renderPlist,
  xmlEscape,
  type ScheduleSpec,
} from '../src/core/schedule.ts'

function spec(over: Partial<ScheduleSpec> = {}): ScheduleSpec {
  return {
    ...defaultSpec({ node: '/usr/local/bin/node', bin: '/opt/coach/dist/coach.mjs', kb: '/Users/me/knowledge', logDir: '/Users/me/knowledge/.coach/logs' }),
    ...over,
  }
}

describe('plist 渲染', () => {
  test('关键键都在，且 RunAtLoad 是 false', () => {
    const p = renderPlist(spec())
    expect(p).toContain('<string>com.coach.digest</string>')
    expect(p).toContain('<string>digest</string>')
    expect(p).toContain('<string>--kb</string>')
    expect(p).toContain('<string>/usr/local/bin/node</string>')
    expect(p).toContain('<string>/opt/coach/dist/coach.mjs</string>')
    // 开机就跑一次会让「周一那份」变成「每次登录一份」
    expect(p).toContain('<key>RunAtLoad</key>\n  <false/>')
  })

  test('每周一 09:00 的默认值', () => {
    const p = renderPlist(spec())
    expect(p).toContain('<key>Weekday</key><integer>1</integer>')
    expect(p).toContain('<key>Hour</key><integer>9</integer>')
    expect(p).toContain('<key>Minute</key><integer>0</integer>')
  })

  test('渲染是确定性的（重复渲染逐字节相同）', () => {
    // 不确定的话 --check 永远报「内容不同」，然后用户就开始忽略它
    expect(renderPlist(spec())).toBe(renderPlist(spec()))
  })

  test('★ 不含任何网络相关的键', () => {
    // digest 不调模型。定时任务出错时没人看得见，所以「可能花钱」那条路
    // 从一开始就不许进这个文件 —— 这条断言就是那道闸门。
    const p = renderPlist(spec())
    for (const k of ['KeepAlive', 'NetworkState', 'Sockets', 'WatchPaths']) {
      expect(p).not.toContain(k)
    }
  })
})

describe('XML 转义', () => {
  test('& < > 都转', () => {
    expect(xmlEscape('a&b<c>d')).toBe('a&amp;b&lt;c&gt;d')
    expect(xmlEscape('/tmp/普通/路径')).toBe('/tmp/普通/路径')
  })

  test('带 & 和 < 的路径不会把 plist 写坏', () => {
    const p = renderPlist(spec({ kb: '/tmp/a&b', bin: '/tmp/x<y>/coach.mjs' }))
    expect(p).toContain('<string>/tmp/a&amp;b</string>')
    expect(p).toContain('<string>/tmp/x&lt;y&gt;/coach.mjs</string>')
    // 没转义的裸字符一个都不许留
    expect(/&(?!amp;|lt;|gt;)/.test(p)).toBe(false)
  })

  test('plutil 认它（含转义那条）', () => {
    if (process.platform !== 'darwin') return
    const dir = mkdtempSync(join(tmpdir(), 'coach-plist-'))
    try {
      for (const s of [spec(), spec({ kb: '/tmp/a&b', bin: '/tmp/x<y>/coach.mjs' })]) {
        const f = join(dir, 'x.plist')
        writeFileSync(f, renderPlist(s))
        const r = spawnSync('plutil', ['-lint', f], { encoding: 'utf8' })
        expect(r.stdout.trim()).toEndWith('OK')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('转义后的值能被 plutil 原样读回来', () => {
    if (process.platform !== 'darwin') return
    const dir = mkdtempSync(join(tmpdir(), 'coach-plist-'))
    try {
      const f = join(dir, 'x.plist')
      writeFileSync(f, renderPlist(spec({ kb: '/tmp/a&b' })))
      const r = spawnSync('plutil', ['-extract', 'ProgramArguments.4', 'raw', '-o', '-', f], { encoding: 'utf8' })
      expect(r.stdout).toBe('/tmp/a&b\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('人话与路径', () => {
  test('describeSchedule 的星期与补零', () => {
    expect(describeSchedule(spec({ weekday: 1, hour: 9, minute: 0 }))).toBe('每周一 09:00')
    expect(describeSchedule(spec({ weekday: 7, hour: 23, minute: 5 }))).toBe('每周日 23:05')
  })

  test('plistPath 落在 LaunchAgents 下，文件名就是 label', () => {
    expect(plistPath('/Users/me')).toBe(`/Users/me/Library/LaunchAgents/${LABEL}.plist`)
  })

  test('launchd 域是用户级 gui/<uid>（不需要 sudo）', () => {
    expect(launchdDomain(501)).toBe('gui/501')
  })

  test('日志留在知识库里 —— 那是私有目录', () => {
    const s = defaultSpec({ node: 'n', bin: 'b', kb: '/k', logDir: '/k/.coach/logs' })
    expect(s.stdout).toBe('/k/.coach/logs/digest.out.log')
    expect(s.stderr).toBe('/k/.coach/logs/digest.err.log')
  })
})
