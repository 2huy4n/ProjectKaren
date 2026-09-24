// 睡眠窗口：每个会话、每一天摇一次入睡/醒来时刻，摇完持久化，不重复摇。
const CLOCK_RE = /^(\d{1,2}):(\d{2})$/

export function parseClock(value, fallbackMinutes) {
  const match = CLOCK_RE.exec(String(value == null ? '' : value).trim())
  if (!match) return fallbackMinutes
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return fallbackMinutes
  return hours * 60 + minutes
}

export function formatClock(minutes) {
  const total = ((Math.round(Number(minutes) || 0) % 1440) + 1440) % 1440
  const pad = (n) => String(n).padStart(2, '0')
  return pad(Math.floor(total / 60)) + ':' + pad(total % 60)
}

export function dayKeyOf(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

/** 一天里的第几分钟（本地时间）。 */
export function minutesOfDay(ms) {
  const d = new Date(ms)
  return d.getHours() * 60 + d.getMinutes()
}

/** 是否落在静默时段（跨午夜有效）；两端任一为空/非法 = 不设静默。 */
export function inQuiet(nowMs, startText, endText) {
  const start = parseClock(startText, -1)
  const end = parseClock(endText, -1)
  if (start < 0 || end < 0 || start === end) return false
  const cur = minutesOfDay(nowMs)
  return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end)
}

/** 稳定伪随机：同一个 seed 永远得到同一个 0..1。 */
export function hashUnit(seed) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100003) / 100003
}

function jittered(baseMinutes, jitter, seed) {
  if (!jitter) return baseMinutes
  return baseMinutes + Math.round((hashUnit(seed) * 2 - 1) * jitter)
}

function startOfDay(ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 从 now 所在那天摇出"今晚"：入睡时刻 + 醒来时刻（醒来可能落到第二天早上）。 */
export function rollNight({ nowMs, sessionId, cfg }) {
  const anchor = startOfDay(nowMs)
  const sleepMinutes = jittered(parseClock(cfg.sleepStart, 1380), cfg.sleepJitter, sessionId + '|sleep|' + anchor)
  const wakeMinutes = jittered(parseClock(cfg.wakeStart, 420), cfg.wakeJitter, sessionId + '|wake|' + anchor)
  const sleepAtMs = anchor + sleepMinutes * 60000
  const overnight = wakeMinutes <= sleepMinutes
  const wakeAtMs = anchor + (overnight ? 1440 : 0) * 60000 + wakeMinutes * 60000
  return { dayKey: dayKeyOf(nowMs), sleepAtMs, wakeAtMs, sleepMinutes, wakeMinutes }
}

/** 今天"中午"那一刻：基准 ± 模糊（同一会话同一天固定）。 */
export function noonAtMs({ nowMs, sessionId, cfg }) {
  const anchor = startOfDay(nowMs)
  const base = parseClock(cfg.noonStart, 720)
  const minutes = jittered(base, cfg.noonJitterMinutes, sessionId + '|noon|' + anchor)
  return anchor + minutes * 60000
}

/** 这一夜是按什么配置摇的——配置一变就得重摇。 */
export function nightKeyOf(cfg) {
  return [cfg.sleepStart, cfg.sleepJitter, cfg.wakeStart, cfg.wakeJitter].join('|')
}

/** 保证状态里的"这一夜"还有效：睡醒了（now 过了 wakeAt）或配置改了，就重摇。 */
export function ensureNight(st, { nowMs, sessionId, cfg }) {
  const key = nightKeyOf(cfg)
  if (st && Number.isFinite(st.wakeAtMs) && nowMs < st.wakeAtMs && st.nightKey === key) return st
  const rolled = rollNight({ nowMs, sessionId, cfg })
  st.dayKey = rolled.dayKey
  st.sleepAtMs = rolled.sleepAtMs
  st.wakeAtMs = rolled.wakeAtMs
  st.sleptMinutes = rolled.sleepMinutes
  st.wokeMinutes = rolled.wakeMinutes
  st.rolledAtMs = nowMs
  st.nightKey = key
  return st
}

/** 现在的状态：asleep / awake（含被吵醒后的临时清醒）。 */
export function phaseOf(st, nowMs) {
  if (st && Number.isFinite(st.awakeUntilMs) && nowMs < st.awakeUntilMs) return 'awake'
  if (!st || !Number.isFinite(st.sleepAtMs) || !Number.isFinite(st.wakeAtMs)) return 'awake'
  return nowMs >= st.sleepAtMs && nowMs < st.wakeAtMs ? 'asleep' : 'awake'
}
