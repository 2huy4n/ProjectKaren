// Durable fictional-life records. This module performs no I/O and makes no model calls.
// The caller owns persistence and supplies the sleep boundary from SessionTimeline.
import { randomUUID } from 'node:crypto'

const FINAL = new Set(['completed', 'cancelled', 'skipped', 'interrupted', 'postponed'])
const ACTIVE = new Set(['planned', 'in_progress'])
const clean = (s, n = 240) => typeof s === 'string' ? s.trim().slice(0, n) : ''
const overlap = (a, b) => a.startAt < b.endAt && b.startAt < a.endAt

export function lifeOf(record) {
  if (!record.life || typeof record.life !== 'object') record.life = {}
  const life = record.life
  if (!life.id) life.id = randomUUID()
  if (!Array.isArray(life.activities)) life.activities = []
  if (!Array.isArray(life.anchors)) life.anchors = []
  if (!Array.isArray(life.facts)) life.facts = []
  return life
}

// Import the old current action once without assuming it finished during downtime.
export function migrateAction(record) {
  const life = lifeOf(record)
  if (record.action && !life.legacyActionImported) {
    const a = record.action
    life.activities.push({ id: randomUUID(), label: clean(a.label), motive: clean(a.motive),
      status: 'in_progress', startAt: a.startedAt, endAt: a.endsAt,
      startedAt: a.startedAt, source: 'legacy' })
    delete record.action
    life.legacyActionImported = true
  }
  return life
}

export function planningContext(life, now, { historyLimit = 12 } = {}) {
  return {
    current: life.activities.filter(a => a.status === 'in_progress'),
    future: life.activities.filter(a => a.status === 'planned'),
    recent: life.activities.filter(a => FINAL.has(a.status)).slice(-historyLimit),
    anchors: life.anchors.filter(a => a.status !== 'cancelled' && (!a.endAt || a.endAt > now)),
    facts: life.facts.slice(-30),
  }
}

// All proposed entries are validated before any are inserted. Existing active entries
// are never silently overwritten; the caller must explicitly transition conflicts.
export function addPlan(life, proposals, { now, windowEnd, sleepAt } = {}) {
  if (!Array.isArray(proposals) || !Number.isFinite(now) || !Number.isFinite(windowEnd) || windowEnd <= now) throw new Error('invalid planning window')
  const staged = []
  for (const p of proposals) {
    const label = clean(p.label)
    const startAt = Number(p.startAt), endAt = Number(p.endAt)
    if (!label || !Number.isFinite(startAt) || !Number.isFinite(endAt) || startAt < now || startAt >= windowEnd || endAt <= startAt || endAt > windowEnd || (Number.isFinite(sleepAt) && endAt > sleepAt)) throw new Error('invalid activity interval')
    const a = { id: randomUUID(), label, motive: clean(p.motive), status: 'planned', startAt, endAt, createdAt: now }
    if ([...life.activities.filter(x => ACTIVE.has(x.status)), ...staged].some(x => overlap(x.status === 'in_progress' && x.endAt < now ? { ...x, endAt: Infinity } : x, a))) throw new Error('activity conflict')
    staged.push(a)
  }
  life.activities.push(...staged)
  life.windowEnd = windowEnd
  return staged
}

export function transition(life, id, status, at, { reason = '', consequences = [] } = {}) {
  const a = life.activities.find(x => x.id === id)
  if (!a || !Number.isFinite(at)) throw new Error('unknown activity or invalid time')
  if (a.status === status) return false
  const allowed = a.status === 'planned' ? ['in_progress', 'cancelled', 'skipped', 'postponed'] : a.status === 'in_progress' ? ['completed', 'cancelled', 'interrupted', 'postponed'] : []
  if (!allowed.includes(status)) throw new Error('invalid activity transition')
  if (status === 'in_progress' && life.activities.some(x => x.id !== id && x.status === 'in_progress')) throw new Error('another activity is in progress')
  a.status = status
  a.updatedAt = at
  if (status === 'in_progress') a.startedAt = at
  else { a.endedAt = at; a.reason = clean(reason) }
  if (status === 'completed' && Array.isArray(consequences)) {
    for (const value of consequences) {
      const text = clean(value)
      if (text && !life.facts.some(f => f.text === text)) life.facts.push({ id: randomUUID(), text, activityId: id, recordedAt: at })
    }
    life.facts = life.facts.slice(-100)
  }
  return true
}

// Select text from DSH session events, never infer state from conversation. System
// messages carry the character/background configured by the host. Bound both the
// number of events and total characters to keep planning cheap on small devices.
export function selectConversation(events) {
  if (!Array.isArray(events)) return { background: '', conversation: [] }
  const text = value => {
    const content = value?.content
    return typeof content === 'string' ? content : Array.isArray(content) ? content.filter(x => x?.type === 'text').map(x => x.text || '').join('\n') : ''
  }
  let background = ''
  const conversation = []
  for (const e of events.slice(-300)) {
    if (e?.type === 'system/message') background = text(e.data?.message) || background
    const m = e?.type === 'user/message' ? e.data : e?.type === 'assistant/message' ? (e.data?.message || e.data) : null
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue
    if (m.role === 'user' && m.source?.kind !== 'user') continue
    const value = text(m).trim()
    if (value) conversation.push({ role: m.role, text: value.slice(0, 800) })
  }
  return { background: background.slice(0, 6000), conversation: conversation.slice(-10) }
}

// One call at a time per session; failed/stale calls are retried later, and a
// response prepared before a sleep or schedule change can never be committed.
export class LifePlanner {
  constructor({ read, save, generate, now = Date.now, retryMs = 300000 }) {
    this.read = read; this.save = save; this.generate = generate; this.now = now
    this.retryMs = retryMs; this.busy = new Set(); this.retry = new Map()
  }
  async tick(id, config, events = []) {
    const at = this.now(), state = this.read(id, at)
    if (!state || state.skipped || state.phase !== 'awake' || this.busy.has(id) || at < (this.retry.get(id) || 0)) return false
    const life = state.life
    const active = life.activities.find(a => a.status === 'in_progress')
    if (active && at < active.endAt) return false
    if (!active && life.windowEnd > at && !life.needsReplan) return false
    const boundary = state.awakeUntilMs > at && state.sleepAtMs <= at ? state.awakeUntilMs : state.sleepAtMs
    const end = Math.min(at + config.planningHorizonMinutes * 60000, Number.isFinite(boundary) && boundary > at ? boundary : Infinity)
    if (end <= at + 60000) return false
    const revision = state.revision
    this.busy.add(id)
    try {
      const result = await this.generate({ sessionId: id, now: at, windowEnd: end, life: planningContext(life, at), ...selectConversation(events) })
      const latest = this.read(id, this.now())
      if (!latest || latest.phase !== 'awake' || latest.skipped || latest.planningEnabled === false || latest.actionEnabled === false || latest.planningHorizonMinutes !== state.planningHorizonMinutes || latest.life.id !== life.id || latest.revision !== revision || latest.sleepAtMs !== state.sleepAtMs || latest.awakeUntilMs !== state.awakeUntilMs || this.now() >= end) return false
      this.save(id, result, { now: at, windowEnd: end, sleepAt: boundary, revision })
      this.retry.delete(id)
      return true
    } catch (error) {
      this.retry.set(id, this.now() + this.retryMs)
      throw error
    } finally { this.busy.delete(id) }
  }
}
