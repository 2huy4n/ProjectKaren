// /mute 的时长解析。
//
// 刻意做得宽松：数字可带各种单位（m/min/minutes/分钟…），也可以直接给时刻。
// 返回值要么是「截止时刻」，要么是明确的失败原因，由调用方决定回哪句文案。
const MAX_MINUTES = 7 * 24 * 60 // 7 天
const MIN_MINUTES = 1

const OFF_WORDS = ['off', 'none', 'stop', 'clear', 'reset', '取消', '解除', '关', '关闭', '停止']

/** 单位 → 分钟。没写单位按分钟算。 */
const UNITS = [
  { re: /^(?:m|min|mins|minute|minutes|分|分钟)$/, minutes: 1 },
  { re: /^(?:h|hr|hrs|hour|hours|时|小时)$/, minutes: 60 },
  { re: /^(?:d|day|days|天)$/, minutes: 1440 },
]

/**
 * 解析 /mute 的参数。
 * @param raw 斜杠指令后面的原始串
 * @param nowMs 插件当前时间（已含调试偏移）
 * @returns {{kind:'off'} | {kind:'until', atMs:number, minutes:number} | {kind:'error', reason:'empty'|'badTime'|'range', input:string}}
 */
export function parseMuteInput(raw, nowMs) {
  const input = String(raw == null ? '' : raw).trim()
  if (!input) return { kind: 'error', reason: 'empty', input }

  if (OFF_WORDS.includes(input.toLowerCase())) return { kind: 'off' }

  // 时刻：22:00 / 到22:00 / until 22:00 / 到 22:00
  const clock = /^(?:到|until|til|till)?\s*(\d{1,2}):(\d{2})$/.exec(input.toLowerCase())
  if (clock) {
    const hour = Number(clock[1])
    const minute = Number(clock[2])
    if (hour > 23 || minute > 59) return { kind: 'error', reason: 'badTime', input }
    const at = new Date(nowMs)
    at.setHours(hour, minute, 0, 0)
    let atMs = at.getTime()
    if (atMs <= nowMs) atMs += 24 * 60 * 60 * 1000 // 今天已过 → 顺延到明天
    const minutes = Math.round((atMs - nowMs) / 60000)
    if (minutes < MIN_MINUTES || minutes > MAX_MINUTES) return { kind: 'error', reason: 'range', input }
    return { kind: 'until', atMs, minutes }
  }

  // 时长：30 / 30m / 30 minutes / 30分钟 / 2h / 1天
  const span = /^(\d+(?:\.\d+)?)\s*([a-z\u4e00-\u9fa5]*)$/.exec(input.toLowerCase())
  if (!span) return { kind: 'error', reason: 'badTime', input }
  const amount = Number(span[1])
  const unitText = span[2] || ''
  let perUnit = 1
  if (unitText) {
    const hit = UNITS.find((u) => u.re.test(unitText))
    if (!hit) return { kind: 'error', reason: 'badTime', input }
    perUnit = hit.minutes
  }
  const minutes = Math.round(amount * perUnit)
  if (!Number.isFinite(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
    return { kind: 'error', reason: 'range', input }
  }
  return { kind: 'until', atMs: nowMs + minutes * 60000, minutes }
}
