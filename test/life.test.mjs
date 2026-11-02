import assert from 'node:assert/strict'
import { lifeOf, migrateAction, addPlan, transition, planningContext } from '../dsh/life.mjs'

const record = { action: { label: 'Read', startedAt: 10, endsAt: 20 } }
let life = migrateAction(record)
assert.equal(migrateAction(record).activities.length, 1)
assert.equal(life.activities[0].status, 'in_progress')
record.life = JSON.parse(JSON.stringify(life))
life = lifeOf(record)
assert.equal(life.activities[0].status, 'in_progress')
const id = life.activities[0].id
assert.equal(transition(life, id, 'completed', 30, { consequences: ['Owns a novel'], confirmation: {kind:'karen_action',activityId:id,callId:'test-call'} }), true)
assert.equal(transition(life, id, 'completed', 30), false)
assert.equal(planningContext(life, 30).recent[0].label, 'Read')
assert.equal(planningContext(life, 30).facts[0].text, 'Owns a novel')
const [planned] = addPlan(life, [{ label: 'Lunch', startAt: 40, endAt: 60 }], { now: 30, windowEnd: 100, sleepAt: 90 })
assert.throws(() => addPlan(life, [{ label: 'Walk', startAt: 50, endAt: 70 }], { now: 30, windowEnd: 100 }), /conflict/)
assert.throws(() => addPlan(life, [{ label: 'Walk', startAt: 80, endAt: 95 }], { now: 30, windowEnd: 100, sleepAt: 90 }), /interval/)
assert.equal(life.activities.length, 2)
transition(life, planned.id, 'in_progress', 40)
assert.equal(planningContext(life, 200).current[0].id, planned.id)
transition(life, planned.id, 'postponed', 200, { reason: 'Sleep' })
assert.equal(planningContext(life, 200).recent.at(-1).status, 'postponed')
console.log('life primitives: ok')
