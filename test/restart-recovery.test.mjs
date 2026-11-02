import assert from 'node:assert/strict'
import { SessionTimeline } from '../dsh/session.mjs'

const at = 100_000
const original = { id: 'life', revision: 3, needsReplan: false, facts: [{ text: 'preserved' }], anchors: [], activities: [
  { id: 'old', status: 'in_progress', startAt: 10, startedAt: 10, endAt: 90_000 },
  { id: 'next', status: 'planned', startAt: 90_000, endAt: 110_000 },
] }
let saved
const state = { owner: { life: structuredClone(original) } }
const timeline = new SessionTimeline({ state, persist: () => { saved = JSON.parse(JSON.stringify(state)) } })
assert.equal(timeline.recoverOverdueLife('owner', at), true)
assert.equal(saved.owner.life.activities[0].status, 'postponed')
assert.equal(saved.owner.life.activities[0].reason, 'Unconfirmed after scheduler restart')
assert.equal(saved.owner.life.activities[1].status, 'planned')
assert.deepEqual(saved.owner.life.facts, original.facts)
assert.equal(saved.owner.life.needsReplan, true)
assert.equal(saved.owner.life.revision, 4)
assert.equal(timeline.recoverOverdueLife('owner', at), false)
const future = { owner: { life: structuredClone(original) } }
future.owner.life.activities[0].endAt = at + 1
assert.equal(new SessionTimeline({ state: future }).recoverOverdueLife('owner', at), false)
const skipped = { owner: { skipped: true, life: structuredClone(original) } }
assert.equal(new SessionTimeline({ state: skipped }).recoverOverdueLife('owner', at), false)
console.log('restart recovery: passed')
