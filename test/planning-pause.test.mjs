import assert from 'node:assert/strict'
import { startKaren } from './harness.mjs'
import { SessionTimeline } from '../dsh/session.mjs'
import { defaultConfig } from '../dsh/store.js'

let requests = 0
const llm = { async *stream(options) {
  requests++
  const input = JSON.parse(options.messages[0].content[0].text)
  const result = input.life.current.length
    ? { resolution: { id: input.life.current[0].id, status: 'postponed', reason: 'Needs more time' }, activities: [], anchors: [] }
    : { activities: [
      { label: 'Read', startAt: input.now, endAt: input.now + 60 * 60000 },
      { label: 'Shop', startAt: input.now + 65 * 60000, endAt: input.now + 90 * 60000 },
    ], anchors: [] }
  yield { type: 'text-delta', text: JSON.stringify(result) }
  yield { type: 'finish', reason: { kind: 'stop' } }
} }
const k = await startKaren({ startAt: new Date(2026, 9, 2, 9).getTime(),
  config: { sleepJitter: 0, wakeJitter: 0, weatherEnabled: false, greetEnabled: false, talkEnabled: false }, llm })
try {
  await k.tickAndSettle()
  await k.tickAndSettle()
  assert.equal(requests, 1)
  let activities = k.readDisk().state[k.sessionId].life.activities
  assert.deepEqual(activities.map(a => a.status), ['in_progress', 'planned'])
  await k.request('POST', '/project-karen/config', { config: { planningEnabled: false } })
  k.advance(70 * 60000)
  await k.tickAndSettle()
  activities = k.readDisk().state[k.sessionId].life.activities
  assert.deepEqual(activities.map(a => a.status), ['in_progress', 'planned'])
  assert.equal(requests, 1)
  assert.match(k.promptOf('project-karen-life'), /Shop/)
  assert.match(k.promptOf('project-karen-action'), /Read/)
  await k.request('POST', '/project-karen/config', { config: { planningEnabled: true } })
  activities = k.readDisk().state[k.sessionId].life.activities
  assert.deepEqual(activities.map(a => a.status), ['in_progress', 'postponed'])
  assert.equal(activities[1].reason, 'Missed while planning was paused')
  await k.tickAndSettle()
  assert.equal(requests, 2)
  assert.equal(k.readDisk().state[k.sessionId].life.activities[0].status, 'postponed')
} finally { k.stop() }

// No activity in progress: a future activity must still not start while paused.
const cfg = { ...defaultConfig(), sleepStart: '23:00', wakeStart: '07:00', sleepJitter: 0, wakeJitter: 0 }
const base = new Date(2026, 9, 3, 9).getTime()
const state = { s: { life: { activities: [ { id: 'p', label: 'Errand', status: 'planned', startAt: base + 60000, endAt: base + 3600000 } ], anchors: [], facts: [] } } }
let timeline = new SessionTimeline({ state, persist: () => true })
timeline.advanceLife('s', { ...cfg, planningEnabled: false }, base)
timeline.advanceLife('s', { ...cfg, planningEnabled: false }, base + 120000)
assert.equal(state.s.life.activities[0].status, 'planned')
const restarted = JSON.parse(JSON.stringify(state))
timeline = new SessionTimeline({ state: restarted, persist: () => true })
timeline.advanceLife('s', cfg, base + 180000)
assert.equal(restarted.s.life.activities[0].status, 'postponed')
assert.equal(restarted.s.life.needsReplan, true)

// The sleep lifecycle still postpones an in-progress activity during a pause.
const beforeSleep = new Date(2026, 9, 4, 22, 30).getTime()
const sleepingState = { s: { life: { activities: [ { id: 'c', label: 'Reading', status: 'in_progress', startAt: beforeSleep, startedAt: beforeSleep, endAt: beforeSleep + 7200000 } ], anchors: [], facts: [] } } }
const sleepTimeline = new SessionTimeline({ state: sleepingState, persist: () => true })
sleepTimeline.advanceLife('s', { ...cfg, planningEnabled: false }, beforeSleep)
sleepTimeline.advanceLife('s', { ...cfg, planningEnabled: false }, beforeSleep + 45 * 60000)
assert.equal(sleepingState.s.life.activities[0].status, 'postponed')
assert.equal(sleepingState.s.life.activities[0].reason, 'Sleep')

// A result started before an off/on toggle is stale, even if it finishes after re-enabling.
let release
const slow = { async *stream() {
  await new Promise(resolve => { release = resolve })
  yield { type: 'text-delta', text: '{"activities":[],"anchors":[]}' }
  yield { type: 'finish', reason: { kind: 'stop' } }
} }
const waiting = await startKaren({ startAt: base, config: { sleepJitter: 0, wakeJitter: 0, weatherEnabled: false, greetEnabled: false, talkEnabled: false }, llm: slow })
try {
  waiting.tick()
  await waiting.settle()
  assert.equal(typeof release, 'function')
  await waiting.request('POST', '/project-karen/config', { config: { planningEnabled: false } })
  await waiting.request('POST', '/project-karen/config', { config: { planningEnabled: true } })
  release()
  await waiting.settle()
  const life = waiting.readDisk().state[waiting.sessionId].life
  assert.equal(life.windowEnd, undefined)
  assert.equal(life.needsReplan, true)
} finally { waiting.stop() }
console.log('rolling planning pause: ok')
