// ProjectKaren 配置 + 每个会话的睡眠/动作状态持久化。
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { normalizeBirthday } from './events.mjs'
import { t, dicts } from './i18n.mjs'

/**
 * 历史上被"冻结"进配置的各语言默认值。
 * photoPrompt 的默认值是一句会随语言变化的文案，旧版本把它物化后落盘了；
 * 装载时认出这些值就等于「其实没设过」，还原成空串让它重新跟随语言。
 */
const KNOWN_PHOTO_DEFAULTS = new Set(
  Object.values(dicts).map((d) => d['default.photoPrompt']).filter(Boolean),
)

export function configPath() {
  const home = process.env.DSH_HOME || path.join(homedir(), '.dsh')
  return path.join(home, 'project-karen.json')
}

export function defaultConfig() {
  return {
    enabled: true,
    sleepStart: '23:00',
    sleepJitter: 30,
    wakeStart: '07:00',
    wakeJitter: 40,
    barrageCount: 5,
    barrageWindowMinutes: 3,
    barrageAwakeMinutes: 30,
    actionEnabled: true,
    actionIntervalMinutes: 90,
    actionJitterMinutes: 30,
    actionIdleMinutes: 10,
    actionDefaultMinutes: 40,
    actionMinMinutes: 10,
    actionMaxMinutes: 180,
    greetEnabled: true,
    nightLeadMinutes: 10,
    defaultMuted: true,
    talkEnabled: true,
    talkIntervalMinutes: 180,
    talkJitterMinutes: 30,
    talkDailyMax: 6,
    talkQuietStart: '23:30',
    talkQuietEnd: '08:00',
    actionDailyMax: 8,
    greetWindowMinutes: 180,
    greetNoonEnabled: true,
    noonStart: '12:00',
    noonJitterMinutes: 60,
    apiBase: 'https://api.siliconflow.cn/v1',
    apiPath: '/images/generations',
    apiKey: '',
    model: 'Qwen/Qwen-Image',
    size: '1024x1024',
    photoPrompt: '',
    // 城市 / 天气：两个城市可以相同（同城）也可以不同（异地）
    citySelf: '',
    cityUser: '',
    weatherEnabled: true,
    // 节日 / 生日
    holidayEnabled: true,
    birthdayEnabled: true,
    birthdaySelf: '',
    birthdayUser: '',
    offsetMinutes: 0,
  }
}

function intOf(value, fallback, min, max) {
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

function textOf(value, fallback, maxLength) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return fallback
  return maxLength ? trimmed.slice(0, maxLength) : trimmed
}

function clockOf(value, fallback) {
  return /^\d{1,2}:\d{2}$/.test(String(value == null ? '' : value).trim()) ? String(value).trim() : fallback
}

/** 和 clockOf 一样，但允许留空表示"关闭"。 */
function clockOrBlank(value, fallback) {
  const raw = String(value == null ? '' : value).trim()
  if (!raw) return ''
  return /^\d{1,2}:\d{2}$/.test(raw) ? raw : fallback
}

/**
 * photoPrompt 必须特殊处理：**空 = 没设过**，由运行时按当前语言取默认值。
 * 它和其他字段不一样——其他字段的默认值是死值，怎么写都无所谓；
 * 而它的默认值是一句话，一旦把译文写进配置就会**永久冻结那个语言**
 * （落盘后永远非空，之后切语言也不会更新）。所以这里不做 fallback，只做"清空"。
 */
function photoPromptOf(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return ''
  if (KNOWN_PHOTO_DEFAULTS.has(raw)) return '' // 旧版本冻结进去的默认值 → 还原成"没设过"
  return raw.slice(0, 800)
}

export function normalizeConfig(raw) {
  const base = defaultConfig()
  const input = raw && typeof raw === 'object' ? raw : {}
  const merged = { ...base, ...input }
  return {
    enabled: merged.enabled !== false,
    sleepStart: clockOf(merged.sleepStart, base.sleepStart),
    sleepJitter: intOf(merged.sleepJitter, base.sleepJitter, 0, 240),
    wakeStart: clockOf(merged.wakeStart, base.wakeStart),
    wakeJitter: intOf(merged.wakeJitter, base.wakeJitter, 0, 240),
    barrageCount: intOf(merged.barrageCount, base.barrageCount, 1, 100),
    barrageWindowMinutes: intOf(merged.barrageWindowMinutes, base.barrageWindowMinutes, 1, 120),
    barrageAwakeMinutes: intOf(merged.barrageAwakeMinutes, base.barrageAwakeMinutes, 1, 720),
    actionEnabled: merged.actionEnabled !== false,
    actionIntervalMinutes: intOf(merged.actionIntervalMinutes, base.actionIntervalMinutes, 5, 1440),
    actionJitterMinutes: intOf(merged.actionJitterMinutes, base.actionJitterMinutes, 0, 720),
    actionIdleMinutes: intOf(merged.actionIdleMinutes, base.actionIdleMinutes, 1, 1440),
    actionDefaultMinutes: intOf(merged.actionDefaultMinutes, base.actionDefaultMinutes, 5, 600),
    actionMinMinutes: intOf(merged.actionMinMinutes, base.actionMinMinutes, 1, 600),
    actionMaxMinutes: intOf(merged.actionMaxMinutes, base.actionMaxMinutes, 5, 1440),
    actionDailyMax: intOf(merged.actionDailyMax, base.actionDailyMax, 0, 200),
    defaultMuted: merged.defaultMuted !== false,
    talkEnabled: merged.talkEnabled !== false,
    talkIntervalMinutes: intOf(merged.talkIntervalMinutes, base.talkIntervalMinutes, 5, 1440),
    talkJitterMinutes: intOf(merged.talkJitterMinutes, base.talkJitterMinutes, 0, 720),
    talkDailyMax: intOf(merged.talkDailyMax, base.talkDailyMax, 0, 96),
    talkQuietStart: clockOrBlank(merged.talkQuietStart, base.talkQuietStart),
    talkQuietEnd: clockOrBlank(merged.talkQuietEnd, base.talkQuietEnd),
    greetEnabled: merged.greetEnabled !== false,
    nightLeadMinutes: intOf(merged.nightLeadMinutes, base.nightLeadMinutes, 0, 180),
    greetWindowMinutes: intOf(merged.greetWindowMinutes, base.greetWindowMinutes, 0, 720),
    greetNoonEnabled: merged.greetNoonEnabled !== false,
    noonStart: clockOf(merged.noonStart, base.noonStart),
    noonJitterMinutes: intOf(merged.noonJitterMinutes, base.noonJitterMinutes, 0, 180),
    apiBase: textOf(merged.apiBase, base.apiBase).replace(/\/+$/, ''),
    apiPath: textOf(merged.apiPath, base.apiPath),
    apiKey: typeof merged.apiKey === 'string' ? merged.apiKey.trim() : base.apiKey,
    model: textOf(merged.model, base.model),
    size: textOf(merged.size, base.size),
    photoPrompt: photoPromptOf(merged.photoPrompt),
    citySelf: textOf(merged.citySelf, base.citySelf, 80),
    cityUser: textOf(merged.cityUser, base.cityUser, 80),
    weatherEnabled: merged.weatherEnabled !== false,
    holidayEnabled: merged.holidayEnabled !== false,
    birthdayEnabled: merged.birthdayEnabled !== false,
    birthdaySelf: normalizeBirthday(merged.birthdaySelf),
    birthdayUser: normalizeBirthday(merged.birthdayUser),
    offsetMinutes: intOf(merged.offsetMinutes, base.offsetMinutes, -100000, 100000),
  }
}

/** 保留多少张照片的引用；附件对象本身在 DSH_HOME/attachments 里，这里只存元数据。 */
const MAX_REFS = 200

export class Store {
  constructor({ filePath, logger, patchConfig } = {}) {
    this.filePath = filePath || configPath()
    this.logger = logger
    const loaded = this.read()
    this.config = normalizeConfig({ ...(patchConfig || {}), ...(loaded.config || {}) })
    this.state = loaded.state && typeof loaded.state === 'object' ? loaded.state : {}
    this.log = Array.isArray(loaded.log) ? loaded.log.slice(-60) : []
    // 照片引用必须持久化：ctx.attachments.readImage(ref) 会拿 ref 去校验
    // mediaType/bytes/width/height，重启后内存里没有它就再也读不回图片了。
    this.refs = loaded.refs && typeof loaded.refs === 'object' && !Array.isArray(loaded.refs) ? loaded.refs : {}
    // 天气缓存：省掉重启后的第一次请求。{ at, self, user }（self/user 是 weather.mjs 的结果）
    this.weather = loaded.weather && typeof loaded.weather === 'object' ? loaded.weather : {}
    // 客户端上报的 DSH 界面语言。宿主侧没有 locale 服务，只能由客户端告诉我们；
    // 它不是用户配置项，所以放独立字段——面板保存 config 时不会把它冲掉。
    this.locale = typeof loaded.locale === 'string' ? loaded.locale : ''
  }

  read() {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch { return {} }
  }

  get offsetMs() { return this.config.offsetMinutes * 60000 }

  sessionState(sessionId) {
    const current = this.state[sessionId]
    if (current && typeof current === 'object') return current
    const fresh = {}
    this.state[sessionId] = fresh
    return fresh
  }

  setConfig(patch) {
    this.config = normalizeConfig({ ...this.config, ...(patch || {}) })
    this.persist()
    return this.config
  }

  pushLog(entry) {
    this.log.push({ ts: Date.now(), ...entry })
    this.log = this.log.slice(-60)
  }

  /** 记下一张照片的引用；只留 readImage 校验用得上的那几个字段。 */
  putRef(ref) {
    const id = String((ref && ref.attachmentId) || '')
    if (!id) return ''
    this.refs[id] = {
      attachmentId: id,
      mediaType: String(ref.mediaType || 'image/png'),
      width: Number(ref.width) || 0,
      height: Number(ref.height) || 0,
      bytes: Number(ref.bytes) || 0,
    }
    const keys = Object.keys(this.refs)
    if (keys.length > MAX_REFS) for (const key of keys.slice(0, keys.length - MAX_REFS)) delete this.refs[key]
    return id
  }

  getRef(id) {
    const found = this.refs[String(id || '')]
    return found && typeof found === 'object' ? found : null
  }

  persist() {
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true })
      const tmp = this.filePath + '.tmp'
      writeFileSync(tmp, JSON.stringify({
        config: this.config,
        state: this.state,
        log: this.log,
        refs: this.refs,
        weather: this.weather,
        locale: this.locale,
      }, null, 2), 'utf-8')
      renameSync(tmp, this.filePath)
      return true
    } catch (error) {
      this.logger?.warn?.(t('err.log.writeFailed', { msg: String(error?.message || error) }))
      return false
    }
  }
}
