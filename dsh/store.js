// ProjectKaren 配置 + 每个会话的睡眠/动作状态持久化。
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

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
    photoPrompt: '中国城市街头随手拍，写实照片，自然光',
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
    photoPrompt: textOf(merged.photoPrompt, base.photoPrompt, 800),
    offsetMinutes: intOf(merged.offsetMinutes, base.offsetMinutes, -100000, 100000),
  }
}

export class Store {
  constructor({ filePath, logger, patchConfig } = {}) {
    this.filePath = filePath || configPath()
    this.logger = logger
    const loaded = this.read()
    this.config = normalizeConfig({ ...(patchConfig || {}), ...(loaded.config || {}) })
    this.state = loaded.state && typeof loaded.state === 'object' ? loaded.state : {}
    this.log = Array.isArray(loaded.log) ? loaded.log.slice(-60) : []
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

  persist() {
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true })
      const tmp = this.filePath + '.tmp'
      writeFileSync(tmp, JSON.stringify({ config: this.config, state: this.state, log: this.log }, null, 2), 'utf-8')
      renameSync(tmp, this.filePath)
      return true
    } catch (error) {
      this.logger?.warn?.('project-karen: 配置写入失败 ' + String(error?.message || error))
      return false
    }
  }
}
