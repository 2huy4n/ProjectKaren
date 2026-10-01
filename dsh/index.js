// ProjectKaren host plugin —— 睡眠/唤醒 + 自由动作 + 出游拍照。
//
// 干的事：
//   1) 给每个会话摇出"今晚的入睡/醒来时刻"（模糊区间内随机），摇完持久化
//   2) 睡着时往系统提示词里注入"你在睡觉，只回一句极短旁白"
//   3) 用户短时间连发很多条消息 → 把角色"吵醒"
//   4) 醒着且没人说话时，每隔一段模糊时间注入一次"自由时间"，让角色主动与所在世界互动
//   5) 提供 karen_photo 工具：角色"拍到照片"时调用它，图片以卡片形式出现在角色那一侧
//
// 角色卡/世界观不由本插件提供：假设会话里已经有角色；没写世界观时默认现实世界的中国。

import { randomUUID } from 'node:crypto'
import { Store, configPath, defaultConfig } from './store.js'
import { ensureNight, phaseOf, formatClock, hashUnit, dayKeyOf, noonAtMs, inQuiet } from './sleep.js'
import { t, setLang, getLang } from './i18n.mjs'
import { weatherKey, isWet, fetchWeather } from './weather.mjs'
import { holidaysOn, birthdayKind, lunarYearCovered, LUNAR_MIN_YEAR, LUNAR_MAX_YEAR } from './events.mjs'
import { parseMuteInput } from './mute.mjs'

export const name = 'project-karen'
export const inject = ['agents', 'tools', 'attachments']

const ROUTE = '/project-karen'
const TICK_MS = 20000

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  try {
    const parsed = JSON.parse(raw || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

const pad2 = (n) => String(n).padStart(2, '0')
const hhmm = (d) => pad2(d.getHours()) + ':' + pad2(d.getMinutes())

function sleepPrompt(st, cfg, nowMs) {
  return t('prompt.sleep', {
    sleptAt: formatClock(st.sleptMinutes),
    wakeAt: hhmm(new Date(st.wakeAtMs)),
    left: Math.max(0, Math.round((st.wakeAtMs - nowMs) / 60000)),
    window: cfg.barrageWindowMinutes,
    count: cfg.barrageCount,
  })
}

function actionPrompt() {
  return t('prompt.action')
}

/** 正在做某件事时，注入"我此刻的处境"——重点是：照样能回消息。 */
function actionSectionText(st, nowMs) {
  const a = st.action
  if (!a) return ''
  return t('prompt.actionSection', {
    label: a.label,
    passed: Math.max(0, Math.round((nowMs - a.startedAt) / 60000)),
    left: Math.max(0, Math.round((a.endsAt - nowMs) / 60000)),
    motive: a.motive ? t('prompt.actionSection.motive', { motive: a.motive }) : '',
  })
}

/** 睡前：道晚安（此时还醒着，能正常说话）。 */
function nightPrompt(st, nowMs) {
  return t('prompt.night', { nowAt: hhmm(new Date(nowMs)), sleptAt: formatClock(st.sleptMinutes) })
}

/** 按钟点挑一个合适的招呼词。 */
function greetWord(at) {
  const hour = at.getHours() + at.getMinutes() / 60
  if (hour < 5) return t('greet.night')
  if (hour < 10) return t('greet.morning')
  if (hour < 11.5) return t('greet.forenoon')
  if (hour < 13) return t('greet.noon')
  if (hour < 18) return t('greet.afternoon')
  return t('greet.evening')
}

/** 睡醒：主动打招呼（只在醒来后一小段时间内触发）。 */
function wakePrompt(st, nowMs) {
  const fresh = nowMs - st.lastWakeAtMs <= 30 * 60000
  return t(fresh ? 'prompt.wake.fresh' : 'prompt.wake.late', {
    wakeAt: hhmm(new Date(st.lastWakeAtMs)),
    nowAt: hhmm(new Date(nowMs)),
    greet: greetWord(new Date(nowMs)),
  })
}

/**
 * 沉默够久了：让角色主动开口找用户。
 * 手上正在忙就把「此刻的处境」写进去——否则提示词会一边说她"手上没别的事"，
 * 一边由 actionSectionText 告诉她"你正在爬山"，两条注入互相打架。
 */
function talkPrompt(silentMinutes, action, nowMs) {
  if (!(action && action.label)) return t('prompt.talk', { silent: silentMinutes })
  return t('prompt.talk.busy', {
    silent: silentMinutes,
    label: action.label,
    passed: Math.max(0, Math.round((nowMs - action.startedAt) / 60000)),
    left: Math.max(0, Math.round((action.endsAt - nowMs) / 60000)),
  })
}

/** 中午：主动说午安。 */
function noonPrompt(nowMs) {
  return t('prompt.noon', { nowAt: hhmm(new Date(nowMs)) })
}

/** 没配生图 Key：干脆别调 karen_photo，直接用文字描写画面。 */
function cameraPrompt() {
  return t('prompt.camera')
}

/** 动作到点了：收尾提示。 */
function actionDonePrompt(a) {
  return t('prompt.actionDone', { label: a.label })
}

/** 有些平台的图片 URL 回 application/octet-stream，靠魔数认格式。 */
function sniffImageType(bytes, fallback) {
  const b = bytes
  if (b.length > 3 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length > 2 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length > 11 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (b.length > 5 && b.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif'
  return fallback || 'image/png'
}

/** OpenAI 兼容的 /images/generations；b64_json 与 url 两种返回都认。 */
async function generateImage(cfg, prompt, signal) {
  const response = await fetch(cfg.apiBase + cfg.apiPath, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {}),
    },
    body: JSON.stringify({ model: cfg.model, prompt, n: 1, size: cfg.size, response_format: 'b64_json' }),
    signal,
  })
  const text = await response.text()
  if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + text.slice(0, 200))
  let parsed
  try { parsed = JSON.parse(text) } catch { throw new Error(t('err.image.notJson', { body: text.slice(0, 160) })) }
  const first = (Array.isArray(parsed && parsed.data) && parsed.data[0]) || (Array.isArray(parsed && parsed.images) && parsed.images[0]) || null
  if (!first) throw new Error(t('err.image.noData', { body: text.slice(0, 160) }))
  if (typeof first.b64_json === 'string' && first.b64_json) {
    const bytes = Buffer.from(first.b64_json, 'base64')
    return { bytes, mediaType: sniffImageType(bytes, 'image/png') }
  }
  const imageUrl = typeof first.url === 'string' ? first.url : (typeof first === 'string' ? first : '')
  if (!imageUrl) throw new Error(t('err.image.badShape', { body: JSON.stringify(first).slice(0, 160) }))
  const img = await fetch(imageUrl, { signal })
  if (!img.ok) throw new Error(t('err.image.fetchFailed', { status: img.status }))
  const bytes = Buffer.from(await img.arrayBuffer())
  const declared = (img.headers.get('content-type') || '').split(';')[0].trim()
  return { bytes, mediaType: /^image\/(png|jpe?g|webp|gif)$/i.test(declared) ? declared.toLowerCase() : sniffImageType(bytes, 'image/png') }
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const store = new Store({ filePath: configPath(), logger, patchConfig: config })
  const entries = new Map()
  let stopping = false

  const now = () => Date.now() + store.offsetMs
  const sessionIdOf = (agent) => String((agent && agent.session && agent.session.id) || (agent && agent.id) || '')

  // 语言：宿主侧没有 locale 服务，只能沿用客户端上次上报的 DSH 界面语言；
  // 从未上报过（比如刚装完还没打开过面板）就退回系统语言。
  if (store.locale) setLang(store.locale)

  // ── 天气（Open-Meteo，免 key）：两个城市，同城/异地两套提示词 ──
  const WEATHER_TTL_MS = 30 * 60 * 1000
  let weatherBusy = false

  const refreshWeather = async (force) => {
    const cfg = store.config
    if (!cfg.weatherEnabled || !cfg.citySelf) return false
    if (weatherBusy) return false
    const sameTargets = store.weather.selfCity === cfg.citySelf && (store.weather.userCity || '') === (cfg.cityUser || '')
    if (!force && sameTargets && now() - (Number(store.weather.at) || 0) < WEATHER_TTL_MS) return false
    weatherBusy = true
    try {
      const lang = getLang()
      const self = await fetchWeather(cfg.citySelf, lang)
      if (!self) {
        logger.warn?.(t('log.weatherCityNotFound', { city: cfg.citySelf }))
        return false
      }
      const needUser = !!cfg.cityUser && cfg.cityUser !== cfg.citySelf
      const user = needUser ? await fetchWeather(cfg.cityUser, lang) : null
      store.weather = { at: now(), selfCity: cfg.citySelf, userCity: cfg.cityUser || '', self, user }
      store.persist()
      return true
    } catch (error) {
      logger.warn?.(t('log.weatherFailed', { msg: String(error?.message || error) }))
      return false
    } finally {
      weatherBusy = false
    }
  }

  /** 天气结果 → 词典占位符。 */
  const weatherVars = (w) => ({
    place: w.place || '',
    condition: t('weather.' + weatherKey(w.code)),
    temp: w.tempC == null ? '?' : w.tempC,
    min: w.tMinC == null ? '?' : w.tMinC,
    max: w.tMaxC == null ? '?' : w.tMaxC,
    wet: isWet(w.code) ? t('prompt.context.wet') : '',
  })

  /**
   * 「今天的情况」：天气 + 节日 + 生日，全是事实性背景。
   * 同城与异地刻意分成两套写法（用户明确要求区分）。
   */
  const contextSectionText = (cfg, at) => {
    const lines = []
    if (cfg.weatherEnabled && (cfg.citySelf || cfg.cityUser)) {
      const self = store.weather.self
      const user = store.weather.user
      const sameCity = !cfg.cityUser || !cfg.citySelf || cfg.cityUser === cfg.citySelf
      if (self && self.place) {
        if (sameCity) {
          lines.push(t('prompt.context.weather.same', weatherVars(self)))
        } else {
          lines.push(t('prompt.context.weather.self', weatherVars(self)))
          if (user && user.place) {
            lines.push(t('prompt.context.weather.user', weatherVars(user)))
            lines.push(t('prompt.context.weather.far'))
          }
        }
      } else {
        lines.push(t('prompt.context.weather.none'))
      }
    }
    if (cfg.holidayEnabled) {
      for (const item of holidaysOn(at)) {
        lines.push(t('prompt.context.holiday', {
          holiday: t('holiday.' + item.id + '.name'),
          hint: t('holiday.' + item.id + '.hint'),
        }))
      }
    }
    if (cfg.birthdayEnabled) {
      const kind = birthdayKind(at, cfg)
      if (kind) lines.push(t('prompt.birthday.' + kind))
    }
    if (!lines.length) return ''
    lines.push(t('prompt.context.rule'))
    return t('prompt.context.head') + '\n' + lines.join('\n')
  }

  /** 会话是否处于 /mute 静默期。 */
  const mutedAt = (st, at) => at < (Number(st && st.mutedUntilMs) || 0)

  const titleOf = (agent) => {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined
      const snapshot = service && typeof service.get === 'function' ? service.get(agent.session) : undefined
      const title = snapshot && (snapshot.title || snapshot.value)
      if (typeof title === 'string' && title.trim()) return title.trim()
    } catch { /* 服务不可用时退回会话 id */ }
    return ''
  }

  const refreshNight = (sessionId) => {
    const st = store.sessionState(sessionId)
    const before = st.wakeAtMs
    ensureNight(st, { nowMs: now(), sessionId, cfg: store.config })
    if (before !== st.wakeAtMs) store.persist()
    return st
  }

  const rollActionDelay = (sessionId, count, cfg) => {
    const jitter = cfg.actionJitterMinutes
    const unit = hashUnit(sessionId + '|action|' + count)
    const minutes = cfg.actionIntervalMinutes + (jitter ? Math.round((unit * 2 - 1) * jitter) : 0)
    return Math.max(1, minutes) * 60000
  }

  const rollTalkDelay = (sessionId, count, cfg) => {
    const jitter = cfg.talkJitterMinutes
    const unit = hashUnit(sessionId + '|talk|' + count)
    const minutes = cfg.talkIntervalMinutes + (jitter ? Math.round((unit * 2 - 1) * jitter) : 0)
    return Math.max(1, minutes) * 60000
  }

  /** 今天某类动作已经做了几次（跨天自动归零）。 */
  const dayUsed = (st, prefix) => (st[prefix + 'Day'] === dayKeyOf(now()) ? st[prefix + 'Count'] || 0 : 0)

  const dayAdd = (st, prefix) => {
    const today = dayKeyOf(now())
    if (st[prefix + 'Day'] !== today) { st[prefix + 'Day'] = today; st[prefix + 'Count'] = 0 }
    st[prefix + 'Count'] = (st[prefix + 'Count'] || 0) + 1
    return st[prefix + 'Count']
  }

  /** 在智能体的空闲窗口里投递：正在跑回合时不打断，交给下一次 tick 重试。 */
  const deliver = (agent, text) => {
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: name },
    }
    const send = () => { agent.followup(message); return true }
    if (agent && typeof agent.runMaintenance === 'function') {
      try {
        // runMaintenance 在别的活动占用空闲时会同步抛错
        return Promise.resolve(agent.runMaintenance(() => Promise.resolve(send()))).then((ok) => ok !== false, () => false)
      } catch { return Promise.resolve(false) }
    }
    try { return Promise.resolve(send()) } catch { return Promise.resolve(false) }
  }

  const stir = (entry, reason) => {
    const st = refreshNight(entry.sessionId)
    const at = now()
    st.awakeUntilMs = at + store.config.barrageAwakeMinutes * 60000
    st.stirredAtMs = at
    st.stirCount = (st.stirCount || 0) + 1
    entry.recent = []
    store.pushLog({ kind: 'stir', sessionId: entry.sessionId, reason: reason || 'barrage', count: st.stirCount })
    store.persist()
    logger.info?.(t('log.stir', { session: entry.sessionId, reason: reason || 'barrage' }))
  }

  const noteUserMessage = (entry, at) => {
    const cfg = store.config
    if (!cfg.enabled) return
    entry.lastUserAt = at
    if (cfg.talkEnabled) entry.nextTalkAt = at + rollTalkDelay(entry.sessionId, entry.talkCount || 0, cfg)
    const windowMs = cfg.barrageWindowMinutes * 60000
    entry.recent = entry.recent.filter((t) => at - t <= windowMs)
    entry.recent.push(at)
    const st = refreshNight(entry.sessionId)
    if (st.skipped) return
    if (phaseOf(st, now()) !== 'asleep') return
    if (entry.recent.length < cfg.barrageCount) return
    stir(entry, 'barrage')
  }

  /** 往会话里插一条插件消息（让角色说点什么）；返回是否真的投递出去了。 */
  const say = (entry, agent, text, kind) => {
    // 静默期内所有主动输出直接吞掉。有意返回 true：不要在解除静默后补发一条已经过期的话。
    if (mutedAt(store.sessionState(entry.sessionId), now())) {
      store.pushLog({ kind: kind + '-muted', sessionId: entry.sessionId })
      return Promise.resolve(true)
    }
    return deliver(agent, text).then((ok) => {
      if (ok) {
        store.pushLog({ kind, sessionId: entry.sessionId })
        logger.info?.('project-karen: ' + kind + ' ' + entry.sessionId)
      } else {
        store.pushLog({ kind: kind + '-held', sessionId: entry.sessionId })
      }
      return ok
    })
  }

  const fireAction = (entry, agent) => {
    const at = now()
    const st = store.sessionState(entry.sessionId)
    if (mutedAt(st, at)) return Promise.resolve(false)
    entry.actionCount = (entry.actionCount || 0) + 1
    entry.lastActionAt = at
    entry.nextActionAt = at + rollActionDelay(entry.sessionId, entry.actionCount, store.config)
    dayAdd(st, 'action')
    store.persist()
    return say(entry, agent, actionPrompt(), 'action').then((ok) => {
      if (!ok) entry.nextActionAt = at + 60000
      return ok
    })
  }

  /** 结束当前动作：清状态 + （非静默、非静默期时）注入收尾提示。 */
  const finishAction = (entry, agent, opts) => {
    const st = store.sessionState(entry.sessionId)
    if (!st.action) return false
    const finished = st.action
    st.action = null
    store.persist()
    if ((opts && opts.silent) || mutedAt(st, now())) {
      store.pushLog({ kind: 'action-dropped', sessionId: entry.sessionId, label: finished.label })
      return true
    }
    return deliver(agent, actionDonePrompt(finished)).then((ok) => {
      store.pushLog({ kind: ok ? 'action-done' : 'action-done-held', sessionId: entry.sessionId, label: finished.label })
      if (ok) logger.info?.(t('log.actionDone', { session: entry.sessionId, label: finished.label }))
      return true
    })
  }

  const tick = (entry, agent) => {
    const cfg = store.config
    if (!cfg.enabled) return
    // 摇夜之前先记下"上一夜是几点醒的"：ensureNight 一旦重摇，wakeAtMs 会直接推到第二天
    const prior = store.sessionState(entry.sessionId)
    const wakeAtBefore = Number.isFinite(prior.wakeAtMs) ? prior.wakeAtMs : NaN
    const st = refreshNight(entry.sessionId)
    const at = now()
    const phase = phaseOf(st, at)
    const muted = mutedAt(st, at)
    if (entry.phase !== phase) {
      entry.phase = phase
      store.pushLog({ kind: phase === 'asleep' ? 'sleep' : 'wake', sessionId: entry.sessionId })
      store.persist()
    }
    // 记下刚过去的那个醒来时刻（重摇后 st.wakeAtMs 已经不是它了）
    if (Number.isFinite(wakeAtBefore) && wakeAtBefore <= at && wakeAtBefore !== st.wakeAtMs) {
      st.lastWakeAtMs = wakeAtBefore
      store.persist()
    }
    const today = dayKeyOf(at)
    if (cfg.greetEnabled && !st.skipped && phase === 'awake' && !muted) {
      // 睡醒：只在醒来后一小段时间内打招呼，每天一次（配置重摇/离线导致的翻转不算睡醒）
      const lateMs = at - Number(st.lastWakeAtMs)
      if (Number.isFinite(st.lastWakeAtMs) && lateMs >= 0 && lateMs <= cfg.greetWindowMinutes * 60000 && st.greetWakeDay !== today) {
        st.greetWakeDay = today
        store.persist()
        say(entry, agent, wakePrompt(st, at), 'greet-wake').then((ok) => { if (!ok) { delete st.greetWakeDay; store.persist() } })
      }
      // 中午：道午安，每天一次；刚睡醒那会儿让早安先说
      if (cfg.greetNoonEnabled) {
        const noonAt = noonAtMs({ nowMs: at, sessionId: entry.sessionId, cfg })
        const noonLateMs = at - noonAt
        const wokeLongAgo = !Number.isFinite(st.lastWakeAtMs) || at - st.lastWakeAtMs > 30 * 60000
        if (noonLateMs >= 0 && noonLateMs <= cfg.greetWindowMinutes * 60000 && wokeLongAgo && st.greetNoonDay !== today) {
          st.greetNoonDay = today
          store.persist()
          say(entry, agent, noonPrompt(at), 'greet-noon').then((ok) => { if (!ok) { delete st.greetNoonDay; store.persist() } })
        }
      }
    }
    // 睡前提前 N 分钟：道晚安（此时还醒着，能正常说话；每天一次）
    if (cfg.greetEnabled && !st.skipped && phase === 'awake' && !muted) {
      const leadMs = cfg.nightLeadMinutes * 60000
      if (Number.isFinite(st.sleepAtMs) && at >= st.sleepAtMs - leadMs && st.greetNightFor !== st.sleepAtMs && st.greetNightDay !== today) {
        st.greetNightFor = st.sleepAtMs
        st.greetNightDay = today
        store.persist()
        say(entry, agent, nightPrompt(st, at), 'greet-night').then((ok) => { if (!ok) { st.greetNightFor = 0; delete st.greetNightDay; store.persist() } })
      }
    }
    if (st.action && at >= st.action.endsAt) finishAction(entry, agent, { silent: phase !== 'awake' })

    // ── 主动搭话：沉默够久就让她先开口（每天有上限，静默时段不打扰）──
    if (cfg.talkEnabled && !st.skipped) {
      if (!Number.isFinite(entry.nextTalkAt)) entry.nextTalkAt = (entry.lastUserAt || at) + rollTalkDelay(entry.sessionId, entry.talkCount || 0, cfg)
      if (muted || phase !== 'awake' || inQuiet(at, cfg.talkQuietStart, cfg.talkQuietEnd)) {
        // 睡着、静默期或正处静默时段：把倒计时往后推，等能打扰了再说
        if (at >= entry.nextTalkAt) entry.nextTalkAt = at + 15 * 60000
      } else if (at >= entry.nextTalkAt) {
        if (cfg.talkDailyMax > 0 && dayUsed(st, 'talk') >= cfg.talkDailyMax) {
          entry.nextTalkAt = at + 30 * 60000
        } else {
          entry.talkCount = (entry.talkCount || 0) + 1
          entry.nextTalkAt = at + rollTalkDelay(entry.sessionId, entry.talkCount, cfg)
          dayAdd(st, 'talk')
          store.persist()
          const silentMinutes = Math.max(1, Math.round((at - (entry.lastUserAt || at)) / 60000))
          say(entry, agent, talkPrompt(silentMinutes, st.action, at), 'talk').then((ok) => { if (!ok) entry.nextTalkAt = at + 60000 })
        }
      }
    }

    if (st.skipped || !cfg.actionEnabled) return
    if (muted) {
      // 静默期：不开始新动作，也不消耗每日额度
      entry.nextActionAt = at + 5 * 60000
      return
    }
    if (phase !== 'awake') {
      entry.nextActionAt = at + rollActionDelay(entry.sessionId, entry.actionCount || 0, cfg)
      return
    }
    if (!Number.isFinite(entry.nextActionAt)) entry.nextActionAt = at + rollActionDelay(entry.sessionId, 0, cfg)
    if (st.action) {
      // 人还在做那件事，别催他做下一件
      entry.nextActionAt = Math.max(at + 60000, st.action.endsAt + 60000)
      return
    }
    if (at < entry.nextActionAt) return
    const idleMs = cfg.actionIdleMinutes * 60000
    if (at - (entry.lastUserAt || 0) < idleMs) {
      entry.nextActionAt = at + idleMs
      return
    }
    if (cfg.actionDailyMax > 0 && dayUsed(st, 'action') >= cfg.actionDailyMax) {
      // 今天的自由动作额度用完了
      entry.nextActionAt = at + 30 * 60000
      return
    }
    fireAction(entry, agent)
  }

  const attach = (agent) => {
    if (stopping || !agent || entries.has(agent)) return
    if (!agent.ctx || typeof agent.ctx.effect !== 'function') {
      logger.warn?.(t('err.attach.noScopedContext'))
      return
    }
    const sessionId = sessionIdOf(agent)
    if (!sessionId) return
    try {
      const isNewSession = !Object.prototype.hasOwnProperty.call(store.state, sessionId)
      const entry = { sessionId, recent: [], phase: '', timer: null, lastUserAt: 0, actionCount: 0, nextActionAt: NaN, lastActionAt: 0, nextTalkAt: NaN, talkCount: 0 }
      if (isNewSession && store.config.defaultMuted) {
        // 唤醒/搭话会往用户的历史里写东西，所以新会话默认静音，要手动「恢复生效」
        store.sessionState(sessionId).skipped = true
        store.persist()
        logger.info?.(t('log.newSessionMuted', { session: sessionId }))
      }
      const cleanup = agent.ctx.effect(() => {
        const section = agent.ctx.systemPrompt && typeof agent.ctx.systemPrompt.section === 'function'
          ? agent.ctx.systemPrompt.section({
              name: 'project-karen-sleep',
              order: 60,
              text: () => {
                try {
                  if (!store.config.enabled) return ''
                  const st = store.sessionState(sessionId)
                  if (st.skipped) return ''
                  ensureNight(st, { nowMs: now(), sessionId, cfg: store.config })
                  return phaseOf(st, now()) === 'asleep' ? sleepPrompt(st, store.config, now()) : ''
                } catch { return '' }
              },
            })
          : () => {}
        const actionSection = agent.ctx.systemPrompt && typeof agent.ctx.systemPrompt.section === 'function'
          ? agent.ctx.systemPrompt.section({
              name: 'project-karen-action',
              order: 61,
              text: () => {
                try {
                  if (!store.config.enabled) return ''
                  const live = store.sessionState(sessionId)
                  if (live.skipped) return ''
                  ensureNight(live, { nowMs: now(), sessionId, cfg: store.config })
                  if (phaseOf(live, now()) !== 'awake') return ''
                  return actionSectionText(live, now())
                } catch { return '' }
              },
            })
          : () => {}
        // 今天的情况：天气 + 节日 + 生日。三者都可开关，全空时不注入。
        const contextSection = agent.ctx.systemPrompt && typeof agent.ctx.systemPrompt.section === 'function'
          ? agent.ctx.systemPrompt.section({
              name: 'project-karen-context',
              order: 59,
              text: () => {
                try {
                  const cfg = store.config
                  if (!cfg.enabled) return ''
                  if (store.sessionState(sessionId).skipped) return ''
                  return contextSectionText(cfg, now())
                } catch { return '' }
              },
            })
          : () => {}
        const cameraSection = agent.ctx.systemPrompt && typeof agent.ctx.systemPrompt.section === 'function'
          ? agent.ctx.systemPrompt.section({
              name: 'project-karen-camera',
              order: 62,
              text: () => {
                try {
                  const cfg = store.config
                  if (!cfg.enabled || cfg.apiKey) return ''
                  if (store.sessionState(sessionId).skipped) return ''
                  return cameraPrompt()
                } catch { return '' }
              },
            })
          : () => {}
        const offEvent = typeof agent.ctx.on === 'function'
          ? agent.ctx.on('session/event', (session, event) => {
              try {
                if (!session || String(session.id) !== sessionId) return
                if (!event || event.type !== 'user/message') return
                if (!event.data || !event.data.source || event.data.source.kind !== 'user') return
                noteUserMessage(entry, Date.now())
              } catch { /* 单条事件出错不影响其它 */ }
            })
          : () => {}
        entry.timer = setInterval(() => tick(entry, agent), TICK_MS)
        return () => {
          try { clearInterval(entry.timer) } catch {}
          try { offEvent() } catch {}
          try { section() } catch {}
          try { actionSection() } catch {}
          try { contextSection() } catch {}
          try { cameraSection() } catch {}
        }
      }, 'project-karen.runtime()')
      entries.set(agent, { entry, cleanup })
      refreshNight(sessionId)
    } catch (error) {
      logger.warn?.(t('err.attach.failed', { msg: String(error?.message || error) }))
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const offCreated = typeof ctx.on === 'function'
        ? ctx.on('agent/created', ({ agent }) => {
            try {
              if (ctx.agents && typeof ctx.agents.roots === 'function' && !ctx.agents.roots().includes(agent)) return
            } catch { /* roots() 不可用时照样挂上去 */ }
            attach(agent)
          })
        : () => {}
      try {
        for (const agent of (ctx.agents && typeof ctx.agents.roots === 'function' ? ctx.agents.roots() : []) || []) attach(agent)
      } catch { /* roots() 不可用 */ }
      // 天气定时刷新：与有没有活跃会话无关。refreshWeather 内部还有 30 分钟 TTL。
      refreshWeather(false)
      const weatherTimer = setInterval(() => { refreshWeather(false) }, 10 * 60 * 1000)
      return async () => {
        stopping = true
        try { clearInterval(weatherTimer) } catch {}
        try { offCreated() } catch {}
        const cleanups = [...entries.values()].map((item) => item.cleanup)
        entries.clear()
        await Promise.allSettled(cleanups.map((cleanup) => Promise.resolve().then(() => cleanup())))
      }
    }, 'project-karen.lifecycle()')
  }

  // ── karen_photo：角色"拍到照片" ─────────────────────────────────────
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    try {
      ctx.tools.register({
        name: 'karen_photo',
        description: t('tool.photo.description'),
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: t('tool.photo.promptParam') },
            caption: { type: 'string', description: t('tool.photo.captionParam') },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              attachmentId: { type: 'string' },
              mediaType: { type: 'string' },
              bytes: { type: 'integer' },
              caption: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['attachmentId', 'mediaType', 'bytes'],
            additionalProperties: false,
          },
          // attachmentId 为空 = 这次没拍到（没配相机）。只回一句普通文字，面板会把它当
          // 普通文字渲染，而不是弹一张红色「照片失败」卡片把人从角色里拽出来。
          render: (_args, value) => [{
            type: 'text',
            text: value.note
              ? value.note
              : t('tool.photo.render', { id: value.attachmentId, bytes: value.bytes }),
          }],
          presentationMeta: (_args, value) => ({
            attachmentId: value.attachmentId,
            mediaType: value.mediaType,
            bytes: value.bytes,
            caption: value.caption || '',
            note: value.note || '',
          }),
        },
        isConcurrencySafe: () => false,
        async execute(args) {
          const cfg = store.config
          if (!cfg.apiKey) {
            // 「没配相机」是正常状态，不是错误：回一句普通文字，让角色顺势改用文字描写。
            return {
              attachmentId: '',
              mediaType: '',
              bytes: 0,
              caption: String((args && args.caption) || ''),
              note: t('tool.photo.nokey'),
            }
          }
          // cfg.photoPrompt 为空 = 用户没设过，用当前语言的默认值
          // （默认值不能落盘：一旦把译文写进配置就会永久冻结那个语言）
          const prompt = String((args && args.prompt) || '').trim() || cfg.photoPrompt || t('default.photoPrompt')
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 180000)
          let got
          try {
            got = await generateImage(cfg, prompt, controller.signal)
          } finally {
            clearTimeout(timer)
          }
          const saved = await ctx.attachments.saveImages([{ data: got.bytes, mediaType: got.mediaType }])
          const ref = saved[0]
          store.putRef(ref)
          store.pushLog({ kind: 'photo', bytes: got.bytes.length, prompt: prompt.slice(0, 40) })
          store.persist()
          return {
            attachmentId: String(ref.attachmentId),
            mediaType: String(ref.mediaType || got.mediaType),
            bytes: got.bytes.length,
            caption: String((args && args.caption) || ''),
          }
        },
      })
      logger.info?.(t('log.toolRegistered', { tool: 'karen_photo' }))

      ctx.tools.register({
        name: 'karen_action',
        description: t('tool.action.description'),
        parameters: {
          type: 'object',
          properties: {
            label: { type: 'string', description: t('tool.action.labelParam') },
            minutes: { type: 'integer', description: t('tool.action.minutesParam') },
            motive: { type: 'string', description: t('tool.action.motiveParam') },
          },
          required: ['label'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              minutes: { type: 'integer' },
              endsAt: { type: 'integer' },
            },
            required: ['label', 'minutes', 'endsAt'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: t('tool.action.render', { label: value.label, minutes: value.minutes }) }],
        },
        isConcurrencySafe: () => false,
        execute(args, exec) {
          const agent = exec && exec.agent
          const sessionId = agent ? sessionIdOf(agent) : ''
          if (!sessionId) throw new Error(t('tool.action.errNoSession'))
          const label = String((args && args.label) || '').trim()
          if (!label) throw new Error(t('tool.action.errNoLabel'))
          const cfg = store.config
          const asked = Math.round(Number(args && args.minutes))
          const raw = Number.isFinite(asked) ? asked : cfg.actionDefaultMinutes
          const minutes = Math.min(cfg.actionMaxMinutes, Math.max(cfg.actionMinMinutes, raw))
          const at = now()
          const st = store.sessionState(sessionId)
          st.action = {
            label,
            motive: String((args && args.motive) || '').trim(),
            minutes,
            startedAt: at,
            endsAt: at + minutes * 60000,
          }
          st.actionCount = (st.actionCount || 0) + 1
          store.pushLog({ kind: 'action-start', sessionId, label })
          store.persist()
          logger.info?.(t('log.actionStart', { session: sessionId, label }))
          return { label, minutes, endsAt: st.action.endsAt }
        },
      })
      logger.info?.(t('log.toolRegistered', { tool: 'karen_action' }))
    } catch (error) {
      logger.warn?.(t('err.tool.registerFailed', { msg: String(error?.message || error) }))
    }
  }

  // ── /mute：让角色闭嘴一段时间（只停主动开口；用户说话照常回）────────
  // 命令执行是 log-only，不会进模型，所以这个指令本身角色不会看到。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['commands'], (scope) => {
        scope.commands.register({
          name: 'mute',
          description: t('cmd.mute.description'),
          input: { hint: t('cmd.mute.hint') },
          recordInput: false,
          handler: (invocation) => {
            const sessionId = sessionIdOf(invocation && invocation.agent)
            if (!sessionId) return { kind: 'error', text: t('cmd.mute.usage') }
            const st = store.sessionState(sessionId)
            if (st.skipped) return { kind: 'error', text: t('cmd.mute.muted') }
            const parsed = parseMuteInput(invocation && invocation.rawInput, now())
            if (parsed.kind === 'error') {
              if (parsed.reason === 'empty') return { kind: 'error', text: t('cmd.mute.usage') }
              if (parsed.reason === 'range') return { kind: 'error', text: t('cmd.mute.badRange') }
              return { kind: 'error', text: t('cmd.mute.badTime', { input: parsed.input }) }
            }
            const wasMuted = mutedAt(st, now())
            if (parsed.kind === 'off') {
              st.mutedUntilMs = 0
              store.pushLog({ kind: 'unmute', sessionId })
              store.persist()
              if (wasMuted) logger.info?.(t('log.unmute', { session: sessionId }))
              return { kind: 'success', text: t('cmd.mute.off') }
            }
            st.mutedUntilMs = parsed.atMs
            store.pushLog({ kind: 'mute', sessionId, until: parsed.atMs })
            store.persist()
            const until = hhmm(new Date(parsed.atMs))
            logger.info?.(t('log.mute', { until, session: sessionId }))
            return {
              kind: 'success',
              text: wasMuted ? t('cmd.mute.extended', { until }) : t('cmd.mute.ok', { until }),
            }
          },
        })
      })
    } catch (error) {
      logger.warn?.(t('err.tool.registerFailed', { msg: String(error?.message || error) }))
    }
  }

  const describe = (agent, entry) => {
    const st = store.sessionState(entry.sessionId)
    const at = now()
    const cfg = store.config
    const nextActionAt = Number.isFinite(entry.nextActionAt) ? entry.nextActionAt : null
    return {
      sessionId: entry.sessionId,
      title: titleOf(agent),
      skipped: !!st.skipped,
      mutedUntil: Number(st.mutedUntilMs) || 0,
      muted: at < (Number(st.mutedUntilMs) || 0),
      phase: phaseOf(st, at),
      sleepAt: Number.isFinite(st.sleepAtMs) ? st.sleepAtMs : null,
      wakeAt: Number.isFinite(st.wakeAtMs) ? st.wakeAtMs : null,
      sleepLocal: Number.isFinite(st.sleptMinutes) ? formatClock(st.sleptMinutes) : null,
      wakeLocal: Number.isFinite(st.wokeMinutes) ? formatClock(st.wokeMinutes) : null,
      minutesToSleep: Number.isFinite(st.sleepAtMs) ? Math.max(0, Math.round((st.sleepAtMs - at) / 60000)) : null,
      minutesToWake: Number.isFinite(st.wakeAtMs) ? Math.max(0, Math.round((st.wakeAtMs - at) / 60000)) : null,
      awakeUntil: Number.isFinite(st.awakeUntilMs) ? st.awakeUntilMs : null,
      stirCount: st.stirCount || 0,
      lastStirAt: Number.isFinite(st.stirredAtMs) ? st.stirredAtMs : null,
      actionCount: st.actionCount || entry.actionCount || 0,
      actionLabel: st.action ? st.action.label : "",
      actionMotive: st.action ? st.action.motive || "" : "",
      actionEndsAt: st.action ? st.action.endsAt : null,
      minutesToActionEnd: st.action ? Math.max(0, Math.round((st.action.endsAt - at) / 60000)) : null,
      lastActionAt: entry.lastActionAt || null,
      nextActionAt,
      minutesToAction: nextActionAt ? Math.max(0, Math.round((nextActionAt - at) / 60000)) : null,
      actionReady: !!(cfg.actionEnabled && !st.skipped && phaseOf(st, at) === 'awake' && nextActionAt && at >= nextActionAt),
      actionToday: dayUsed(st, 'action'),
      talkEnabled: !!cfg.talkEnabled,
      talkCount: entry.talkCount || 0,
      talkToday: dayUsed(st, 'talk'),
      nextTalkAt: Number.isFinite(entry.nextTalkAt) ? entry.nextTalkAt : null,
      minutesToTalk: Number.isFinite(entry.nextTalkAt) ? Math.max(0, Math.round((entry.nextTalkAt - at) / 60000)) : null,
      quietNow: inQuiet(at, cfg.talkQuietStart, cfg.talkQuietEnd),
      lastUserAt: entry.lastUserAt || null,
    }
  }

  const status = () => {
    const cfg = store.config
    const at = now()
    return {
      ok: true,
      path: store.filePath,
      lang: getLang(),
      config: { ...cfg, apiKey: cfg.apiKey ? '***' + cfg.apiKey.slice(-4) : '' },
      defaults: defaultConfig(),
      nowMs: at,
      agents: [...entries.entries()].map(([agent, item]) => describe(agent, item.entry)),
      log: store.log.slice(-30).reverse(),
      weather: {
        at: Number(store.weather.at) || null,
        self: store.weather.self || null,
        user: store.weather.user || null,
        selfCity: store.weather.selfCity || '',
        userCity: store.weather.userCity || '',
        selfText: store.weather.self ? t('weather.' + weatherKey(store.weather.self.code)) : '',
        userText: store.weather.user ? t('weather.' + weatherKey(store.weather.user.code)) : '',
      },
      today: {
        holidays: cfg.holidayEnabled
          ? holidaysOn(at).map((h) => ({ id: h.id, name: t('holiday.' + h.id + '.name'), lunar: h.lunar }))
          : [],
        birthday: cfg.birthdayEnabled ? birthdayKind(at, cfg) : null,
      },
      lunar: {
        covered: lunarYearCovered(new Date(at).getFullYear()),
        min: LUNAR_MIN_YEAR,
        max: LUNAR_MAX_YEAR,
      },
    }
  }

  const debug = (body) => {
    const action = String(body.action || '')
    const wanted = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : ''
    // weather-now 跟具体会话无关：直接刷一次就走，不进下面的循环
    if (action === 'weather-now') { refreshWeather(true); return 1 }
    let affected = 0
    for (const [agent, item] of entries) {
      const entry = item.entry
      if (wanted && entry.sessionId !== wanted) continue
      const st = refreshNight(entry.sessionId)
      const at = now()
      if (action === 'sleep-now') {
        st.sleepAtMs = at - 1000
        st.wakeAtMs = at + 8 * 3600 * 1000
        st.sleptMinutes = new Date(at).getHours() * 60 + new Date(at).getMinutes()
        st.wokeMinutes = (st.sleptMinutes + 480) % 1440
        st.awakeUntilMs = 0
      } else if (action === 'wake-now') {
        st.awakeUntilMs = 0
        st.wakeAtMs = at - 1000
      } else if (action === 'reset') {
        delete store.state[entry.sessionId]
      } else if (action === 'stir-now') {
        stir(entry, 'debug')
      } else if (action === 'skip') {
        st.skipped = true
      } else if (action === 'unskip') {
        st.skipped = false
      } else if (action === 'act-now') {
        fireAction(entry, agent)
      } else if (action === 'end-action') {
        if (!finishAction(entry, agent, {})) continue
      } else {
        return affected
      }
      affected += 1
      if (action !== 'reset' && action !== 'stir-now' && action !== 'act-now') entry.phase = ''
    }
    store.persist()
    return affected
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (scope) => {
        scope.webServer.register({
          kind: 'exact',
          path: ROUTE + '/status',
          handler: (req, res) => {
            if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
            sendJson(res, 200, status())
          },
        })
        // 客户端把 ctx.locale 解析出的界面语言报上来——宿主侧没有 locale 服务，
        // 这是「让注入的提示词跟随 DSH 界面语言」的唯一途径。
        scope.webServer.register({
          kind: 'exact',
          path: ROUTE + '/locale',
          handler: async (req, res) => {
            if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
            try {
              const body = await readJsonBody(req)
              const next = setLang(body && body.lang)
              if (next !== store.locale) { store.locale = next; store.persist() }
              sendJson(res, 200, { ok: true, lang: next })
            } catch (error) {
              sendJson(res, 400, { ok: false, error: String(error?.message || error) })
            }
          },
        })
        scope.webServer.register({
          kind: 'exact',
          path: ROUTE + '/config',
          handler: async (req, res) => {
            try {
              if (req.method === 'GET') { sendJson(res, 200, { ok: true, value: status().config, defaults: defaultConfig(), path: store.filePath }); return }
              if (req.method !== 'POST') { res.writeHead(405, { allow: 'GET, POST' }); res.end(); return }
              const body = await readJsonBody(req)
              const incoming = body && typeof body.config === 'object' ? { ...body.config } : { ...body }
              // '' / undefined = 「不改」；'***xxxx' 是面板回显的脱敏值，同样不能当成新 Key 写回去，
              // 否则用户在面板里改任何别的设置再点保存，真实 Key 就会被这个掩码覆盖掉。
              if (incoming.apiKey === '' || incoming.apiKey === undefined || /^\*{3}/.test(incoming.apiKey)) delete incoming.apiKey
              const value = store.setConfig(incoming)
              for (const [, item] of entries) refreshNight(item.entry.sessionId)
              refreshWeather(false) // 城市改了要立刻重取（内部会比对目标城市）
              sendJson(res, 200, { ok: true, value: { ...value, apiKey: value.apiKey ? '***' + value.apiKey.slice(-4) : '' } })
            } catch (error) {
              sendJson(res, 400, { ok: false, error: String(error?.message || error) })
            }
          },
        })
        scope.webServer.register({
          kind: 'exact',
          path: ROUTE + '/debug',
          handler: async (req, res) => {
            if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
            try {
              const body = await readJsonBody(req)
              sendJson(res, 200, { ok: true, affected: debug(body) })
            } catch (error) {
              sendJson(res, 400, { ok: false, error: String(error?.message || error) })
            }
          },
        })
        scope.webServer.register({
          kind: 'exact',
          path: ROUTE + '/clear',
          handler: async (req, res) => {
            if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
            try {
              const body = await readJsonBody(req)
              const target = String(body.target || '')
              if (target === 'log') {
                const removed = store.log.length
                store.log = []
                store.persist()
                logger.info?.(t('log.logCleared', { count: removed }))
                sendJson(res, 200, { ok: true, removed })
                return
              }
              if (target === 'apiKey') {
                // 直接 setConfig：/config 那条路把空字符串当成"不修改"，这里要的是真清掉
                store.setConfig({ apiKey: '' })
                logger.info?.(t('log.keyCleared'))
                sendJson(res, 200, { ok: true })
                return
              }
              sendJson(res, 400, { ok: false, error: t('err.config.unknownTarget', { target }) })
            } catch (error) {
              sendJson(res, 400, { ok: false, error: String(error?.message || error) })
            }
          },
        })
        // 前缀路由不能带结尾斜杠，否则 DSH 匹配不上（踩过的坑）。
        scope.webServer.register({
          kind: 'prefix',
          path: ROUTE,
          handler: async (req, res) => {
            const url = String(req.url || '').split('?')[0]
            if (!url.startsWith(ROUTE + '/raw/')) { sendJson(res, 404, { ok: false, error: t('err.route.notFound', { url }) }); return }
            const id = decodeURIComponent(url.slice((ROUTE + '/raw/').length))
            const ref = store.getRef(id)
            if (!ref || typeof ctx.attachments.readImage !== 'function') { sendJson(res, 404, { ok: false, error: t('err.attachment.unknownId', { id }) }); return }
            try {
              const stored = await ctx.attachments.readImage(ref)
              const bytes = Buffer.from(stored.data)
              res.writeHead(200, {
                'Content-Type': (stored.ref && stored.ref.mediaType) || ref.mediaType || 'image/png',
                'Content-Length': bytes.length,
                'Cache-Control': 'no-store',
              })
              res.end(bytes)
            } catch (error) {
              sendJson(res, 404, { ok: false, error: String(error?.message || error) })
            }
          },
        })
      })
    } catch (error) {
      logger.warn?.(t('err.route.registerFailed', { msg: String(error?.message || error) }))
    }
  }
}
