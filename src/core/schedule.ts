// 周期跑 `coach digest` 的 LaunchAgent（macOS）。
//
// 为什么是 launchd 不是 cron：macOS 上 cron 已经废弃、还要用户自己去授
// Full Disk Access；而 launchd 的 `StartCalendarInterval` 在**错过了时间点
// （关机、睡眠）之后会在下次唤醒时补跑**。周报要的正是这个语义 ——
// 「周一早上看一眼上周」。cron 会直接把那一周跳过，而且不告诉你。
//
// ★ 这个 plist 里**不含任何网络动作**，因为它跑的 `coach digest` 一次模型
//   都不调（见 digest.ts 文件头）。定时任务出错时没人看得见，所以「可能花钱」
//   的那条路从一开始就不许进这个文件 —— 这里连 PATH 都不给，
//   digest 不需要 spawn 任何东西。
//
// 纯渲染 + 两条路径。读写、launchctl 那部分在 commands/install.ts，
// 这样这个文件可以整份拿去断言。

import { homedir } from 'node:os'
import { join } from 'node:path'

export const LABEL = 'com.coach.digest'

export interface ScheduleSpec {
  /** 跑它的运行时，**绝对路径**。launchd 的 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin。 */
  node: string
  /** coach.mjs 的绝对路径。 */
  bin: string
  /** 知识库绝对路径。 */
  kb: string
  /** 1=周一 … 7=周日（launchd 用 0 和 7 都表示周日，这里只用 1–7）。 */
  weekday: number
  hour: number
  minute: number
  stdout: string
  stderr: string
}

export function defaultSpec(o: { node: string; bin: string; kb: string; logDir: string }): ScheduleSpec {
  return {
    node: o.node,
    bin: o.bin,
    kb: o.kb,
    // 周一 09:00。挑上午是刻意的：周末攒下的活还没开始，看一眼正合适。
    weekday: 1,
    hour: 9,
    minute: 0,
    stdout: join(o.logDir, 'digest.out.log'),
    stderr: join(o.logDir, 'digest.err.log'),
  }
}

export function plistPath(home = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`)
}

const WEEKDAY_ZH = ['', '一', '二', '三', '四', '五', '六', '日']

/** 供输出用的人话，例如「每周一 09:00」。 */
export function describeSchedule(s: ScheduleSpec): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `每周${WEEKDAY_ZH[s.weekday] ?? '?'} ${p(s.hour)}:${p(s.minute)}`
}

/**
 * XML 转义。
 *
 * 路径里带 `&` 或 `<` 的项目目录不是假想 —— 不转义写出来的 plist 会直接
 * 解析失败，而 launchd 对此的反应是**这个任务从此不存在**，一声不吭。
 */
export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function renderPlist(s: ScheduleSpec): string {
  const x = xmlEscape
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${x(LABEL)}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${x(s.node)}</string>
    <string>${x(s.bin)}</string>
    <string>digest</string>
    <string>--kb</string>
    <string>${x(s.kb)}</string>
  </array>

  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>${s.weekday}</integer>
    <key>Hour</key><integer>${s.hour}</integer>
    <key>Minute</key><integer>${s.minute}</integer>
  </dict>

  <key>StandardOutPath</key>
  <string>${x(s.stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${x(s.stderr)}</string>

  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`
}

/** launchctl 认的域。gui/<uid> —— 用户级，不需要 sudo，也不需要开机就起的 daemon。 */
export function launchdDomain(uid: number): string {
  return `gui/${uid}`
}
