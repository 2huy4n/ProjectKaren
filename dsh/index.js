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

function sleepPrompt(st, cfg, nowMs) {
  const wakeDate = new Date(st.wakeAtMs)
  const pad = (n) => String(n).padStart(2, '0')
  const wakeText = pad(wakeDate.getHours()) + ':' + pad(wakeDate.getMinutes())
  const left = Math.max(0, Math.round((st.wakeAtMs - nowMs) / 60000))
  return [
    '## 睡眠中（ProjectKaren）',
    '你现在在睡觉：这次大约 ' + formatClock(st.sleptMinutes) + ' 睡下，预计 ' + wakeText + ' 左右醒来（还有约 ' + left + ' 分钟）。',
    '',
    '睡着的规矩：',
    '- 用户的消息你会看到，但**不要回应内容**。',
    '- 只回一句极短的旁白，描述你睡得很沉、没有察觉（一两句带括号的动作描写即可）。',
    '- 不要展开对话，不要调用任何工具。',
    '- 唯一例外：如果用户在 ' + cfg.barrageWindowMinutes + ' 分钟内连续发来约 ' + cfg.barrageCount + ' 条以上消息（被短信轰炸），你会被吵醒；那时再自然地从睡梦里醒来回应。',
  ].join('\n')
}

function actionPrompt(cfg) {
  return [
    '## 自由时间（ProjectKaren）',
    '现在没人在跟你说话。按你的角色设定，做点什么。',
    '',
    '规矩：',
    '1. **先看上下文找动机**：如果你答应了谁要做什么、或者有件正在做/还没做完的事，优先去做那件（有动机的动作）。',
    '2. 没有明确动机时，随便做一件与你所在世界互动的小事：出门走走、买东西、看窗外、刷手机、做饭、发呆、跟路人搭话……（出游只是其中一种，别老出门）',
    '3. 决定做什么之后，调用 karen_action 工具登记一下（label=你在做什么，minutes=大概要多久，motive=为什么做）。这样之后有人跟你说话时，你会知道自己"正在外面/正在忙"。',
    '   时长要**贴近现实**：买杯奶茶/下楼买点东西 10~20 分钟，吃顿饭 40~90 分钟，逛街 1~2 小时，逛景点 1~3 小时。别把"吃一顿火锅"写成 3 分钟，也别把"买杯奶茶"写成半小时以上。',
    '4. **照片不是常态**：默认只用文字描述就好。只有两种情况下才调用 karen_photo 发照片——(a) 你出游到了明确的名胜景点/值得拍下来的地方；(b) 用户明确要你拍照。其它时候（在家做饭、下楼买东西、发呆）不要发照片。',
    '5. 这是你自己的时间：**不要主动找用户说话**——不要称呼或提及用户、不要提问、不要邀请、不要等回应。就当用户不在场，用旁白或内心独白说出你在做什么。',
    '6. 不要解释你在执行任务；用一两句自然的话说你在做什么。',
    '',
    '世界观：以角色卡或当前对话的设定为准；没有设定时默认现实世界的中国。',
  ].join('\n')
}

/** 正在做某件事时，注入"我此刻的处境"——重点是：照样能回消息。 */
function actionSectionText(st, cfg, nowMs) {
  const a = st.action
  if (!a) return ''
  const passed = Math.max(0, Math.round((nowMs - a.startedAt) / 60000))
  const left = Math.max(0, Math.round((a.endsAt - nowMs) / 60000))
  return [
    '## 你此刻的处境（ProjectKaren · 背景信息，不是用户发来的消息）',
    '你正在：' + a.label + '（开始于约 ' + passed + ' 分钟前，还剩约 ' + left + ' 分钟）。' +
      (a.motive ? '你做这件事的原因：' + a.motive + '。' : ''),
    '',
    '请注意：',
    '- **用户此刻没有说话**。上面这段不是用户的消息，只是你对自己处境的记忆。',
    '- 所以现在**不要回应任何人、不要主动找用户说话、更不要编造用户发来的消息**。',
    '- 继续做你正在做的事就好；需要的话用旁白/内心独白继续，不要汇报行程、不要邀请用户。',
    '- 只有当用户**真的**发来一条单独的消息时，你才照常回——就像人在外面掏出手机看一眼，语气里带上此刻的处境即可。',
  ].join('\n')
}

/** 睡前：道晚安（此时还醒着，能正常说话）。 */
function nightPrompt(st, cfg, nowMs) {
  const at = new Date(nowMs)
  const pad = (n) => String(n).padStart(2, '0')
  return [
    '## 差不多该睡了（ProjectKaren）',
    '现在是 ' + pad(at.getHours()) + ':' + pad(at.getMinutes()) + '，你准备睡觉了（大约 ' + formatClock(st.sleptMinutes) + ' 睡下，到点后你会睡着、不再回复消息）。',
    '用一两句自然的话跟大家道个晚安——像你平时睡前那样，可以带上此刻的状态（困了/在收拾/钻进被窝）。',
    '不要提问、不要等回复、不要长篇大论；说完就去睡。',
  ].join('\n')
}

/** 按钟点挑一个合适的招呼词。 */
function greetWord(at) {
  const hour = at.getHours() + at.getMinutes() / 60
  if (hour < 5) return '晚上好'
  if (hour < 10) return '早上好'
  if (hour < 11.5) return '上午好'
  if (hour < 13) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

/** 睡醒：主动打招呼（只在醒来后一小段时间内触发）。 */
function wakePrompt(st, cfg, nowMs) {
  const at = new Date(nowMs)
  const wakeAt = new Date(st.lastWakeAtMs)
  const pad = (n) => String(n).padStart(2, '0')
  const hhmm = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes())
  const fresh = nowMs - st.lastWakeAtMs <= 30 * 60000
  return [
    '## 你醒了（ProjectKaren）',
    fresh
      ? '你刚睡醒（大约 ' + hhmm(wakeAt) + ' 醒来，现在是 ' + hhmm(at) + '）。'
      : '你今天大约 ' + hhmm(wakeAt) + ' 就醒了，现在已经是 ' + hhmm(at) + '。',
    '主动跟人说一句' + greetWord(at) + '——照你平时的说话方式，' + (fresh ? '带上刚睡醒的样子' : '自然一点') + '，顺带一句今天的小打算，一两句就够。',
    '不用提问、不用等人回复；没人应你就当自言自语。不要提"系统"或"插件"。',
  ].join('\n')
}

/** 沉默够久了：让角色主动开口找用户。 */
function talkPrompt(cfg, silentMinutes) {
  return [
    '## 该开口了（ProjectKaren）',
    '用户已经 ' + silentMinutes + ' 分钟没说话了，你现在醒着、手上也没别的事。',
    '',
    '按你的角色设定，**主动找用户说一句话**——像忽然想起对方、或者正好有话想说那样自然。',
    '写的时候注意：',
    '- 不要提"沉默了多少分钟""系统""插件"这类词，也不要解释你为什么突然说话。',
    '- 一两句就够，不要长篇大论、不要连环追问。',
    '- 这是你自己想开口，不是在等回复。',
  ].join('\n')
}

/** 中午：主动说午安。 */
function noonPrompt(cfg, nowMs) {
  const at = new Date(nowMs)
  const pad = (n) => String(n).padStart(2, '0')
  return [
    '## 中午了（ProjectKaren）',
    '现在是 ' + pad(at.getHours()) + ':' + pad(at.getMinutes()) + '，中午这段。',
    '主动跟人说一句午安——照你平时的说话方式，带一句你此刻在做什么（在吃午饭 / 忙手上的事 / 刚歇下来），一两句就够。',
    '不用提问、不用等人回复；没人应你就当自言自语。不要提"系统"或"插件"。',
  ].join('\n')
}

/** 没配生图 Key：干脆别调 karen_photo，直接用文字描写画面。 */
function cameraPrompt(cfg) {
  return [
    '## 你现在没有相机（ProjectKaren）',
    '生图没有配置好，所以你**拍不了照、不要调用 karen_photo**。',
    '想跟人分享眼前的景象时，直接用文字把它写出来（看到什么、光线、声音、气味），一样可以发。',
  ].join('\n')
}

/** 动作到点了：收尾提示。 */
function actionDonePrompt(a) {
  return [
    '## 动作结束（ProjectKaren）',
    '你的动作「' + a.label + '」到时间了，人已经回到平时的状态。',
    '用一两句话自然收个尾（自言自语式的旁白即可），**不要主动跟用户搭话、不要提问或邀请**；如果用户先开口，再正常回。',
    '如果你这趟是出游、而且去到了明确的名胜景点（或用户要你拍），可以调用 karen_photo 发一张照片；其它情况只用文字说。',
  ].join('\n')
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
  try { parsed = JSON.parse(text) } catch { throw new Error('生图返回不是 JSON：' + text.slice(0, 160)) }
  const first = (Array.isArray(parsed && parsed.data) && parsed.data[0]) || (Array.isArray(parsed && parsed.images) && parsed.images[0]) || null
  if (!first) throw new Error('生图返回里没有图片数据：' + text.slice(0, 160))
  if (typeof first.b64_json === 'string' && first.b64_json) {
    const bytes = Buffer.from(first.b64_json, 'base64')
    return { bytes, mediaType: sniffImageType(bytes, 'image/png') }
  }
  const imageUrl = typeof first.url === 'string' ? first.url : (typeof first === 'string' ? first : '')
  if (!imageUrl) throw new Error('无法识别的生图返回结构：' + JSON.stringify(first).slice(0, 160))
  const img = await fetch(imageUrl, { signal })
  if (!img.ok) throw new Error('取图失败 HTTP ' + img.status)
  const bytes = Buffer.from(await img.arrayBuffer())
  const declared = (img.headers.get('content-type') || '').split(';')[0].trim()
  return { bytes, mediaType: /^image\/(png|jpe?g|webp|gif)$/i.test(declared) ? declared.toLowerCase() : sniffImageType(bytes, 'image/png') }
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const store = new Store({ filePath: configPath(), logger, patchConfig: config })
  const entries = new Map()
  const refs = new Map()
  let stopping = false

  const now = () => Date.now() + store.offsetMs
  const sessionIdOf = (agent) => String((agent && agent.session && agent.session.id) || (agent && agent.id) || '')

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
    logger.info?.('project-karen: 吵醒 ' + entry.sessionId + '（' + (reason || 'barrage') + '）')
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
  const say = (entry, agent, text, kind) => deliver(agent, text).then((ok) => {
    if (ok) {
      store.pushLog({ kind, sessionId: entry.sessionId })
      logger.info?.('project-karen: ' + kind + ' ' + entry.sessionId)
    } else {
      store.pushLog({ kind: kind + '-held', sessionId: entry.sessionId })
    }
    return ok
  })

  const fireAction = (entry, agent) => {
    const at = now()
    const st = store.sessionState(entry.sessionId)
    entry.actionCount = (entry.actionCount || 0) + 1
    entry.lastActionAt = at
    entry.nextActionAt = at + rollActionDelay(entry.sessionId, entry.actionCount, store.config)
    dayAdd(st, 'action')
    store.persist()
    return say(entry, agent, actionPrompt(store.config), 'action').then((ok) => {
      if (!ok) entry.nextActionAt = at + 60000
      return ok
    })
  }

  /** 结束当前动作：清状态 + （非静默时）注入收尾提示。 */
  const finishAction = (entry, agent, opts) => {
    const st = store.sessionState(entry.sessionId)
    if (!st.action) return false
    const finished = st.action
    st.action = null
    store.persist()
    if (opts && opts.silent) {
      store.pushLog({ kind: 'action-dropped', sessionId: entry.sessionId, label: finished.label })
      return true
    }
    return deliver(agent, actionDonePrompt(finished)).then((ok) => {
      store.pushLog({ kind: ok ? 'action-done' : 'action-done-held', sessionId: entry.sessionId, label: finished.label })
      if (ok) logger.info?.('project-karen: 动作结束 ' + entry.sessionId + ' ' + finished.label)
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
    if (cfg.greetEnabled && !st.skipped && phase === 'awake') {
      // 睡醒：只在醒来后一小段时间内打招呼，每天一次（配置重摇/离线导致的翻转不算睡醒）
      const lateMs = at - Number(st.lastWakeAtMs)
      if (Number.isFinite(st.lastWakeAtMs) && lateMs >= 0 && lateMs <= cfg.greetWindowMinutes * 60000 && st.greetWakeDay !== today) {
        st.greetWakeDay = today
        store.persist()
        say(entry, agent, wakePrompt(st, cfg, at), 'greet-wake').then((ok) => { if (!ok) { delete st.greetWakeDay; store.persist() } })
      }
      // 中午：道午安，每天一次；刚睡醒那会儿让早安先说
      if (cfg.greetNoonEnabled) {
        const noonAt = noonAtMs({ nowMs: at, sessionId: entry.sessionId, cfg })
        const noonLateMs = at - noonAt
        const wokeLongAgo = !Number.isFinite(st.lastWakeAtMs) || at - st.lastWakeAtMs > 30 * 60000
        if (noonLateMs >= 0 && noonLateMs <= cfg.greetWindowMinutes * 60000 && wokeLongAgo && st.greetNoonDay !== today) {
          st.greetNoonDay = today
          store.persist()
          say(entry, agent, noonPrompt(cfg, at), 'greet-noon').then((ok) => { if (!ok) { delete st.greetNoonDay; store.persist() } })
        }
      }
    }
    // 睡前提前 N 分钟：道晚安（此时还醒着，能正常说话；每天一次）
    if (cfg.greetEnabled && !st.skipped && phase === 'awake') {
      const leadMs = cfg.nightLeadMinutes * 60000
      if (Number.isFinite(st.sleepAtMs) && at >= st.sleepAtMs - leadMs && st.greetNightFor !== st.sleepAtMs && st.greetNightDay !== today) {
        st.greetNightFor = st.sleepAtMs
        st.greetNightDay = today
        store.persist()
        say(entry, agent, nightPrompt(st, cfg, at), 'greet-night').then((ok) => { if (!ok) { st.greetNightFor = 0; delete st.greetNightDay; store.persist() } })
      }
    }
    if (st.action && at >= st.action.endsAt) finishAction(entry, agent, { silent: phase !== 'awake' })

    // ── 主动搭话：沉默够久就让她先开口（每天有上限，静默时段不打扰）──
    if (cfg.talkEnabled && !st.skipped) {
      if (!Number.isFinite(entry.nextTalkAt)) entry.nextTalkAt = (entry.lastUserAt || at) + rollTalkDelay(entry.sessionId, entry.talkCount || 0, cfg)
      if (phase !== 'awake' || inQuiet(at, cfg.talkQuietStart, cfg.talkQuietEnd)) {
        // 睡着或正处静默时段：把倒计时往后推，等能打扰了再说
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
          say(entry, agent, talkPrompt(cfg, silentMinutes), 'talk').then((ok) => { if (!ok) entry.nextTalkAt = at + 60000 })
        }
      }
    }

    if (st.skipped || !cfg.actionEnabled) return
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
      logger.warn?.('project-karen: agent 缺少 scoped context，跳过')
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
        logger.info?.('project-karen: 新会话默认静音 ' + sessionId)
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
                  return actionSectionText(live, store.config, now())
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
                  return cameraPrompt(cfg)
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
          try { cameraSection() } catch {}
        }
      }, 'project-karen.runtime()')
      entries.set(agent, { entry, cleanup })
      refreshNight(sessionId)
    } catch (error) {
      logger.warn?.('project-karen: attach 失败 ' + String(error?.message || error))
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
      return async () => {
        stopping = true
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
        description:
          '把一张"你拍到的照片"发到对话里（以图片卡片的形式显示在你自己这一侧）。' +
          '只在两种情况下用：(a) 你出游到了明确的名胜景点，想拍下来分享；(b) 用户明确要你拍。' +
          '日常小事（在家做饭、下楼买东西）不要用这个工具，用文字描述即可。' +
          '照片会用配置好的生图模型按 prompt 画出来；没配 API Key 时会报错，那时改用文字描述画面。',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '画面的描述（中文即可）；不填就用配置里的默认提示词' },
            caption: { type: 'string', description: '照片下面的一句话（比如"路过一家面馆"）' },
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
            },
            required: ['attachmentId', 'mediaType', 'bytes'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: '照片已显示在对话里（' + value.attachmentId + '，' + value.bytes + ' 字节）' }],
          presentationMeta: (_args, value) => ({
            attachmentId: value.attachmentId,
            mediaType: value.mediaType,
            bytes: value.bytes,
            caption: value.caption || '',
          }),
        },
        isConcurrencySafe: () => false,
        async execute(args) {
          const cfg = store.config
          if (!cfg.apiKey) throw new Error('karen_photo: 没有配置生图 API Key（请在 ProjectKaren 面板里填写）；先用文字描述这张照片。')
          const prompt = String((args && args.prompt) || '').trim() || cfg.photoPrompt
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
          refs.set(String(ref.attachmentId), ref)
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
      logger.info?.('project-karen: 工具 karen_photo 已注册')

      ctx.tools.register({
        name: 'karen_action',
        description:
          '登记你"正在做的一件事"（出门买奶茶、在家做饭、去上班……出游只是其中一种）。登记后你会知道自己此刻的处境，' +
          '到时间会被提醒收尾。有明确动机（答应了别人、事情没做完）时优先做那件事。',
        parameters: {
          type: 'object',
          properties: {
            label: { type: 'string', description: '你在做什么，一句话（比如"去楼下便利店买冰可乐"）' },
            minutes: { type: 'integer', description: '大概要多久（分钟），要贴近现实（买奶茶 10~20、吃饭 40~90、逛景点 60~180）；不填用默认值。超出面板设定的最短/最长会被自动夹到边界' },
            motive: { type: 'string', description: '为什么做这件事（可选，比如"主人让我买的"）' },
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
          render: (_args, value) => [{ type: 'text', text: '已登记动作：' + value.label + '（预计 ' + value.minutes + ' 分钟后结束）' }],
        },
        isConcurrencySafe: () => false,
        execute(args, exec) {
          const agent = exec && exec.agent
          const sessionId = agent ? sessionIdOf(agent) : ''
          if (!sessionId) throw new Error('karen_action: 找不到当前会话，无法登记动作。')
          const label = String((args && args.label) || '').trim()
          if (!label) throw new Error('karen_action: label 不能为空。')
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
          logger.info?.('project-karen: 动作开始 ' + sessionId + ' ' + label)
          return { label, minutes, endsAt: st.action.endsAt }
        },
      })
      logger.info?.('project-karen: 工具 karen_action 已注册')
    } catch (error) {
      logger.warn?.('project-karen: 工具注册失败 ' + String(error?.message || error))
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

  const status = () => ({
    ok: true,
    path: store.filePath,
    config: { ...store.config, apiKey: store.config.apiKey ? '***' + store.config.apiKey.slice(-4) : '' },
    defaults: defaultConfig(),
    nowMs: now(),
    agents: [...entries.entries()].map(([agent, item]) => describe(agent, item.entry)),
    log: store.log.slice(-30).reverse(),
  })

  const debug = (body) => {
    const action = String(body.action || '')
    const wanted = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : ''
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
        scope.webServer.register({
          kind: 'exact',
          path: ROUTE + '/config',
          handler: async (req, res) => {
            try {
              if (req.method === 'GET') { sendJson(res, 200, { ok: true, value: status().config, defaults: defaultConfig(), path: store.filePath }); return }
              if (req.method !== 'POST') { res.writeHead(405, { allow: 'GET, POST' }); res.end(); return }
              const body = await readJsonBody(req)
              const incoming = body && typeof body.config === 'object' ? { ...body.config } : { ...body }
              if (incoming.apiKey === '' || incoming.apiKey === undefined) delete incoming.apiKey
              const value = store.setConfig(incoming)
              for (const [, item] of entries) refreshNight(item.entry.sessionId)
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
                logger.info?.('project-karen: 日志已清空（' + removed + ' 条）')
                sendJson(res, 200, { ok: true, removed })
                return
              }
              if (target === 'apiKey') {
                // 直接 setConfig：/config 那条路把空字符串当成"不修改"，这里要的是真清掉
                store.setConfig({ apiKey: '' })
                logger.info?.('project-karen: 生图 API Key 已清空')
                sendJson(res, 200, { ok: true })
                return
              }
              sendJson(res, 400, { ok: false, error: 'unknown target: ' + target })
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
            if (!url.startsWith(ROUTE + '/raw/')) { sendJson(res, 404, { ok: false, error: 'no such route ' + url }); return }
            const id = decodeURIComponent(url.slice((ROUTE + '/raw/').length))
            const ref = refs.get(id)
            if (!ref || typeof ctx.attachments.readImage !== 'function') { sendJson(res, 404, { ok: false, error: 'unknown id ' + id }); return }
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
      logger.warn?.('project-karen: 路由注册失败 ' + String(error?.message || error))
    }
  }
}
