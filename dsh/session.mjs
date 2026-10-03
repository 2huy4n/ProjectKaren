// 会话时间线：一个会话只有一份状态，按 sessionId 取；状态怎么变，也由这里说了算。
//
// 改动之前，一个会话的状态住在两个地方，键还不一样：
//   · 内存里的 entries Map，按 **agent 对象** 键，字段是
//     sessionId / recent / phase / lastUserAt / actionCount / nextActionAt /
//     lastActionAt / nextTalkAt / talkCount
//   · 落盘的 store.state，按 **sessionId** 键
// 于是 describe() 得用 `st.actionCount || entry.actionCount` 兜住两边打架，
// debug 的 reset 只删得掉一半，而 tick、attach、两个工具、/mute 一共八个地方
// 直接往记录里写 —— 没有任何一处知道完整的规则。
//
// 现在两件事都收在这里：
//   1. 一份记录，按 sessionId 取，记录本身**不可从外部拿到**（私有方法持有）。
//   2. 状态怎么变由 due() 一个入口决定，返回「这一 tick 要做什么」的意图列表；
//      投递与文案仍归 index.js，模块不碰 agent、不碰 i18n。
//
// 易失字段为什么不能落盘：它们承载的是「重启后重新计时」这个既有行为 —— 插件
// 重启后 nextTalkAt / nextActionAt 按完整间隔重排（是延迟，不是立刻触发）。一旦
// 把它们写进 JSON，重启就会读回来，行为跟着变。
//
// 做法：把易失字段做成**不可枚举的访问器**，背后挂本模块自己的 Map。
//   · 读写照常，调用方看不出区别
//   · Object.keys / JSON.stringify 看不见它们
//   → 磁盘格式与重启行为都不变，而调用方只认识一份记录
//
// 字段改名说明：易失的活动计数与持久的每日计数原本**同名**（都叫 actionCount
// 与 talkCount），这正是 describe() 需要 `||` 兜底的根因。这里把易失的两个改成
// actionRollCount / talkRollCount（它们只当抖动种子用），持久的沿用原名不动，
// 因此磁盘上的键一个没变。客户端看到的字段名由 describe() 这个适配器负责。
import { ensureNight, phaseOf, hashUnit, dayKeyOf, noonAtMs, inQuiet } from './sleep.js'

/** 易失字段及其初值。进程重启后应当回到这里给出的初值。 */
const VOLATILE = {
  recent: () => [],
  phase: () => '',
  lastUserAt: () => 0,
  nextActionAt: () => NaN,
  lastActionAt: () => 0,
  nextTalkAt: () => NaN,
  actionRollCount: () => 0,
  talkRollCount: () => 0,
}

const num = (value) => (Number.isFinite(value) ? value : null)

export class SessionTimeline {
  /**
   * @param state   持久化桶，直接就是 store.state —— 记录就挂在这上面，
   *                于是 store.persist() 照旧能把它写出去，不必改任何落盘调用点。
   * @param persist 落盘回调
   * @param log     日志回调（插件只留最近 60 条，写内存）
   */
  constructor({ state, persist, log } = {}) {
    this.state = state && typeof state === 'object' ? state : {}
    this.persist = typeof persist === 'function' ? persist : () => {}
    this.log = typeof log === 'function' ? log : () => {}
    this.volatile = new Map()
    this.records = new Map()
  }

  // ── 记录本体：私有，外部拿不到 ────────────────────────────────────
  #of(sessionId) {
    const id = String(sessionId == null ? '' : sessionId)
    if (!id) return null
    const cached = this.records.get(id)
    if (cached) return cached

    const stored = this.state[id]
    const record = stored && typeof stored === 'object' ? stored : (this.state[id] = {})

    const volatile = {}
    for (const [key, seed] of Object.entries(VOLATILE)) {
      volatile[key] = seed()
      Object.defineProperty(record, key, {
        enumerable: false,
        configurable: true,
        get() { return volatile[key] },
        set(next) { volatile[key] = next },
      })
    }

    this.volatile.set(id, volatile)
    this.records.set(id, record)
    return record
  }

  /** 摇夜：睡醒了或配置改了才重摇；重摇就落盘。 */
  #ensureNight(record, sessionId, cfg, at) {
    const before = record.wakeAtMs
    ensureNight(record, { nowMs: at, sessionId, cfg })
    if (before !== record.wakeAtMs) this.persist()
  }

  /** 今天某类动作已经做了几次（跨天自动归零）。键的拼法只在这里出现。 */
  #dayUsed(record, prefix, at) {
    return record[prefix + 'Day'] === dayKeyOf(at) ? record[prefix + 'Count'] || 0 : 0
  }

  #dayAdd(record, prefix, at) {
    const today = dayKeyOf(at)
    if (record[prefix + 'Day'] !== today) { record[prefix + 'Day'] = today; record[prefix + 'Count'] = 0 }
    record[prefix + 'Count'] = (record[prefix + 'Count'] || 0) + 1
    return record[prefix + 'Count']
  }

  #rollAction(sessionId, count, cfg) {
    const jitter = cfg.actionJitterMinutes
    const unit = hashUnit(sessionId + '|action|' + count)
    const minutes = cfg.actionIntervalMinutes + (jitter ? Math.round((unit * 2 - 1) * jitter) : 0)
    return Math.max(1, minutes) * 60000
  }

  #rollTalk(sessionId, count, cfg) {
    const jitter = cfg.talkJitterMinutes
    const unit = hashUnit(sessionId + '|talk|' + count)
    const minutes = cfg.talkIntervalMinutes + (jitter ? Math.round((unit * 2 - 1) * jitter) : 0)
    return Math.max(1, minutes) * 60000
  }

  /** 做一次自发动作的状态迁移（不含投递）。返回是否真的做了。 */
  #fire(record, sessionId, cfg, at) {
    record.actionRollCount = (record.actionRollCount || 0) + 1
    record.lastActionAt = at
    record.nextActionAt = at + this.#rollAction(sessionId, record.actionRollCount, cfg)
    this.#dayAdd(record, 'action', at)
    this.persist()
  }

  // ── 查询 ──────────────────────────────────────────────────────────

  /** 磁盘上见过这个会话没有 —— 用来判断「是不是第一次见到它」。 */
  has(sessionId) {
    const id = String(sessionId == null ? '' : sessionId)
    return !!id && Object.prototype.hasOwnProperty.call(this.state, id)
  }

  isSkipped(sessionId) {
    const record = this.#of(sessionId)
    return !!(record && record.skipped)
  }

  isMuted(sessionId, at) {
    const record = this.#of(sessionId)
    return !!record && at < (Number(record.mutedUntilMs) || 0)
  }

  /**
   * 给调用方看的一份只读快照。record 本身不外泄，形状由模块负责；
   * 顺便保证夜次是新的，所以读到的 sleepAt/wakeAt 不会陈旧。
   */
  snapshot(sessionId, cfg, at) {
    const record = this.#of(sessionId)
    if (!record) return null
    this.#ensureNight(record, sessionId, cfg, at)
    return {
      sessionId: String(sessionId),
      skipped: !!record.skipped,
      mutedUntil: Number(record.mutedUntilMs) || 0,
      muted: at < (Number(record.mutedUntilMs) || 0),
      phase: phaseOf(record, at),
      sleepAtMs: num(record.sleepAtMs),
      wakeAtMs: num(record.wakeAtMs),
      sleptMinutes: num(record.sleptMinutes),
      wokeMinutes: num(record.wokeMinutes),
      awakeUntilMs: num(record.awakeUntilMs),
      lastWakeAtMs: num(record.lastWakeAtMs),
      stirCount: record.stirCount || 0,
      stirredAtMs: num(record.stirredAtMs),
      action: record.action ? { ...record.action } : null,
      actionDayCount: record.actionCount || 0,
      actionRollCount: record.actionRollCount || 0,
      lastActionAt: record.lastActionAt || 0,
      nextActionAt: record.nextActionAt,
      talkDayCount: record.talkCount || 0,
      talkRollCount: record.talkRollCount || 0,
      nextTalkAt: record.nextTalkAt,
      lastUserAt: record.lastUserAt || 0,
      actionsToday: this.#dayUsed(record, 'action', at),
      talksToday: this.#dayUsed(record, 'talk', at),
    }
  }

  // ── 状态迁移 ──────────────────────────────────────────────────────

  /** 彻底清掉一个会话：持久那一半与易失那一半一起，不留半截。 */
  reset(sessionId) {
    const id = String(sessionId == null ? '' : sessionId)
    if (!id) return false
    this.records.delete(id)
    this.volatile.delete(id)
    return delete this.state[id]
  }

  setMute(sessionId, untilMs) {
    const record = this.#of(sessionId)
    if (!record) return false
    record.mutedUntilMs = Number(untilMs) || 0
    this.persist()
    return true
  }

  setSkipped(sessionId, value) {
    const record = this.#of(sessionId)
    if (!record) return false
    record.skipped = !!value
    this.persist()
    return true
  }

  /** 取出并清空当前动作（不投递）。没有动作时返回 null。 */
  takeAction(sessionId) {
    const record = this.#of(sessionId)
    if (!record || !record.action) return null
    const finished = { ...record.action }
    record.action = null
    this.persist()
    return finished
  }

  /**
   * 调试开关里「只改状态」的那几个：立刻睡 / 立刻醒 / 跳过 / 恢复。
   * 需要投递的（stir-now / act-now / end-action）由调用方另行处理。
   * 返回 true 表示这个动作被这里处理了。
   */
  debugApply(sessionId, at, action) {
    const record = this.#of(sessionId)
    if (!record) return false
    if (action === 'sleep-now') {
      record.sleepAtMs = at - 1000
      record.wakeAtMs = at + 8 * 3600 * 1000
      record.sleptMinutes = new Date(at).getHours() * 60 + new Date(at).getMinutes()
      record.wokeMinutes = (record.sleptMinutes + 480) % 1440
      record.awakeUntilMs = 0
    } else if (action === 'wake-now') {
      record.awakeUntilMs = 0
      record.wakeAtMs = at - 1000
    } else if (action === 'skip') {
      record.skipped = true
    } else if (action === 'unskip') {
      record.skipped = false
    } else {
      return false
    }
    record.phase = ''
    this.persist()
    return true
  }

  /** 某个工具/指令直接开一个动作（karen_action）。 */
  startAction(sessionId, action, at) {
    const record = this.#of(sessionId)
    if (!record) return null
    const stored = {
      label: action.label,
      motive: action.motive || '',
      minutes: action.minutes,
      startedAt: at,
      endsAt: at + action.minutes * 60000,
    }
    record.action = stored
    record.actionCount = (record.actionCount || 0) + 1
    this.persist()
    return { ...stored }
  }

  /** 用户说话了：更新沉默计时、累计轰炸窗口，够数就把她吵醒。 */
  noteUserMessage(sessionId, cfg, at) {
    if (!cfg.enabled) return 0
    const record = this.#of(sessionId)
    if (!record) return 0
    record.lastUserAt = at
    if (cfg.talkEnabled) record.nextTalkAt = at + this.#rollTalk(String(sessionId), record.talkRollCount || 0, cfg)
    const windowMs = cfg.barrageWindowMinutes * 60000
    record.recent = record.recent.filter((stamp) => at - stamp <= windowMs)
    record.recent.push(at)
    this.#ensureNight(record, sessionId, cfg, at)
    if (record.skipped) return 0
    if (phaseOf(record, at) !== 'asleep') return 0
    if (record.recent.length < cfg.barrageCount) return 0
    return this.stir(sessionId, cfg, at, 'barrage')
  }

  /** 把她从睡里吵醒：临时清醒一段时间，计数 +1。返回累计被吵醒次数。 */
  stir(sessionId, cfg, at, reason) {
    const record = this.#of(sessionId)
    if (!record) return 0
    this.#ensureNight(record, sessionId, cfg, at)
    record.awakeUntilMs = at + cfg.barrageAwakeMinutes * 60000
    record.stirredAtMs = at
    record.stirCount = (record.stirCount || 0) + 1
    record.recent = []
    this.log({ kind: 'stir', sessionId, reason: reason || 'barrage', count: record.stirCount })
    this.persist()
    return record.stirCount
  }

  /** 调试用：绕过间隔与空闲闸门，直接让她做一件事（静默期仍然挡住）。 */
  forceAction(sessionId, cfg, at) {
    const record = this.#of(sessionId)
    if (!record) return false
    if (this.isMuted(sessionId, at)) return false
    this.#fire(record, sessionId, cfg, at)
    return true
  }

  // ── 投递失败时的回退（投递本身归调用方） ──────────────────────────

  /** 问候没送出去：把「今天已问候」的标记撤掉，下一 tick 还能再试。 */
  undoGreet(sessionId, kind) {
    const record = this.#of(sessionId)
    if (!record) return
    if (kind === 'greet-wake') delete record.greetWakeDay
    if (kind === 'greet-noon') delete record.greetNoonDay
    if (kind === 'greet-night') { record.greetNightFor = 0; delete record.greetNightDay }
    this.persist()
  }

  retryTalk(sessionId, at) {
    const record = this.#of(sessionId)
    if (!record) return
    record.nextTalkAt = at + 60000
  }

  retryAction(sessionId, at) {
    const record = this.#of(sessionId)
    if (!record) return
    record.nextActionAt = at + 60000
  }

  /**
   * 走一次 tick 的决策：内部按固定顺序做状态迁移，返回这一轮要投递的意图。
   *
   * 顺序是有意义的，不要重排：
   *   1. 摇夜 + 记下刚过去的醒来时刻 + 阶段翻转
   *   2. 问候（睡醒 / 午安 / 晚安）
   *   3. 结算到点的动作（会清空 action，影响后面搭话的提示词）
   *   4. 搭话
   *   5. 自由动作
   *
   * 返回的意图只描述「说什么 / 做什么」，文案由调用方用 vars 渲染。
   */
  due(sessionId, cfg, at) {
    const record = this.#of(sessionId)
    if (!record) return { skipped: true, muted: false, phase: 'awake', intents: [] }

    // 1. 摇夜之前先记下"上一夜是几点醒的"：ensureNight 一旦重摇，wakeAtMs 会直接推到第二天
    const wakeAtBefore = Number.isFinite(record.wakeAtMs) ? record.wakeAtMs : NaN
    this.#ensureNight(record, sessionId, cfg, at)
    if (Number.isFinite(wakeAtBefore) && wakeAtBefore <= at && wakeAtBefore !== record.wakeAtMs) {
      record.lastWakeAtMs = wakeAtBefore
      this.persist()
    }

    const phase = phaseOf(record, at)
    const muted = at < (Number(record.mutedUntilMs) || 0)
    if (record.phase !== phase) {
      record.phase = phase
      this.log({ kind: phase === 'asleep' ? 'sleep' : 'wake', sessionId })
      this.persist()
    }

    const intents = []
    const today = dayKeyOf(at)
    const canSpeak = !record.skipped && phase === 'awake' && !muted

    // 2. 问候
    if (cfg.greetEnabled && canSpeak) {
      // 睡醒：只在醒来后一小段时间内打招呼，每天一次（配置重摇/离线导致的翻转不算睡醒）
      const lateMs = at - Number(record.lastWakeAtMs)
      if (Number.isFinite(record.lastWakeAtMs) && lateMs >= 0 && lateMs <= cfg.greetWindowMinutes * 60000 && record.greetWakeDay !== today) {
        record.greetWakeDay = today
        this.persist()
        intents.push({
          kind: 'greet-wake',
          vars: { at, lastWakeAtMs: record.lastWakeAtMs },
        })
      }
      // 中午：道午安，每天一次；刚睡醒那会儿让早安先说
      if (cfg.greetNoonEnabled) {
        const noonAt = noonAtMs({ nowMs: at, sessionId, cfg })
        const noonLateMs = at - noonAt
        const wokeLongAgo = !Number.isFinite(record.lastWakeAtMs) || at - record.lastWakeAtMs > 30 * 60000
        if (noonLateMs >= 0 && noonLateMs <= cfg.greetWindowMinutes * 60000 && wokeLongAgo && record.greetNoonDay !== today) {
          record.greetNoonDay = today
          this.persist()
          intents.push({ kind: 'greet-noon', vars: { at } })
        }
      }
    }
    // 睡前提前 N 分钟：道晚安（此时还醒着，能正常说话；每天一次）
    if (cfg.greetEnabled && canSpeak) {
      const leadMs = cfg.nightLeadMinutes * 60000
      if (Number.isFinite(record.sleepAtMs) && at >= record.sleepAtMs - leadMs && record.greetNightFor !== record.sleepAtMs && record.greetNightDay !== today) {
        record.greetNightFor = record.sleepAtMs
        record.greetNightDay = today
        this.persist()
        intents.push({ kind: 'greet-night', vars: { at, sleptMinutes: record.sleptMinutes } })
      }
    }

    // 3. 结算到点的动作（先于搭话：清空 action 会改变搭话的提示词）
    if (record.action && at >= record.action.endsAt) {
      const finished = { ...record.action }
      record.action = null
      this.persist()
      intents.push({ kind: 'action-done', action: finished, silent: phase !== 'awake' })
    }

    // 4. 搭话：沉默够久就让她先开口（每天有上限，静默时段不打扰）
    if (cfg.talkEnabled && !record.skipped) {
      if (!Number.isFinite(record.nextTalkAt)) {
        record.nextTalkAt = (record.lastUserAt || at) + this.#rollTalk(String(sessionId), record.talkRollCount || 0, cfg)
      }
      if (muted || phase !== 'awake' || inQuiet(at, cfg.talkQuietStart, cfg.talkQuietEnd)) {
        // 睡着、静默期或正处静默时段：把倒计时往后推，等能打扰了再说
        if (at >= record.nextTalkAt) record.nextTalkAt = at + 15 * 60000
      } else if (at >= record.nextTalkAt) {
        if (cfg.talkDailyMax > 0 && this.#dayUsed(record, 'talk', at) >= cfg.talkDailyMax) {
          record.nextTalkAt = at + 30 * 60000
        } else {
          record.talkRollCount = (record.talkRollCount || 0) + 1
          record.nextTalkAt = at + this.#rollTalk(String(sessionId), record.talkRollCount, cfg)
          this.#dayAdd(record, 'talk', at)
          this.persist()
          intents.push({
            kind: 'talk',
            silentMinutes: Math.max(1, Math.round((at - (record.lastUserAt || at)) / 60000)),
            action: record.action ? { ...record.action } : null,
            at,
          })
        }
      }
    }

    // 5. 自由动作
    if (!record.skipped && cfg.actionEnabled) {
      if (muted) {
        // 静默期：不开始新动作，也不消耗每日额度
        record.nextActionAt = at + 5 * 60000
      } else if (phase !== 'awake') {
        record.nextActionAt = at + this.#rollAction(String(sessionId), record.actionRollCount || 0, cfg)
      } else if (!Number.isFinite(record.nextActionAt)) {
        record.nextActionAt = at + this.#rollAction(String(sessionId), 0, cfg)
      } else if (record.action) {
        // 人还在做那件事，别催他做下一件
        record.nextActionAt = Math.max(at + 60000, record.action.endsAt + 60000)
      } else if (at >= record.nextActionAt) {
        const idleMs = cfg.actionIdleMinutes * 60000
        if (at - (record.lastUserAt || 0) < idleMs) {
          record.nextActionAt = at + idleMs
        } else if (cfg.actionDailyMax > 0 && this.#dayUsed(record, 'action', at) >= cfg.actionDailyMax) {
          // 今天的自由动作额度用完了
          record.nextActionAt = at + 30 * 60000
        } else {
          this.#fire(record, String(sessionId), cfg, at)
          intents.push({ kind: 'action' })
        }
      }
    }

    return { phase, muted, skipped: !!record.skipped, intents }
  }
}
