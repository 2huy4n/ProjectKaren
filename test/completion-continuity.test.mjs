import assert from 'node:assert/strict'
import { startKaren } from './harness.mjs'
import { SessionTimeline } from '../dsh/session.mjs'
import { planningContext } from '../dsh/life.mjs'
import { defaultConfig } from '../dsh/store.js'

const at = new Date(2026, 9, 2, 9).getTime()
let calls = 0, secondInput
const llm = { async *stream(options) {
  const input = JSON.parse(options.messages[0].content[0].text)
  calls++
  if (calls === 2) secondInput = input
  yield { type: 'text-delta', text: JSON.stringify({ anchors: [], activities: calls === 1 ? [{ label: 'Buy a novel', startAt: input.now, endAt: input.now + 600000 }] : [] }) }
  yield { type: 'finish', reason: { kind: 'stop' } }
} }
const k = await startKaren({ startAt: at, config: { sleepJitter: 0, wakeJitter: 0, weatherEnabled: false, greetEnabled: false, talkEnabled: false }, llm })
try {
  await k.tickAndSettle(); await k.tickAndSettle()
  const activity = k.readDisk().state[k.sessionId].life.activities[0]
  assert.equal(activity.status, 'in_progress')
  assert.match(k.promptOf('project-karen-life'), new RegExp(activity.id))
  const action = k.tools.get('karen_action')
  const exec = { agent: k.agent, callId: 'confirmed-call-1' }
  assert.throws(() => action.execute({ label: 'Wrong', completeActivityId: activity.id }, exec), /does not match/)
  assert.throws(() => action.execute({ label: activity.label, completeActivityId: activity.id }, { agent: k.agent }), /identified tool call/)
  action.execute({ label: activity.label, completeActivityId: activity.id, consequences: ['Owns the novel'] }, exec)
  action.execute({ label: activity.label, completeActivityId: activity.id, consequences: ['Should not be added'] }, exec)
  const life = k.readDisk().state[k.sessionId].life
  assert.equal(life.activities[0].status, 'completed')
  assert.equal(life.activities[0].confirmation.callId, 'confirmed-call-1')
  assert.deepEqual(life.facts.map(f => f.text), ['Owns the novel'])
  const restarted = new SessionTimeline({state:JSON.parse(JSON.stringify(k.readDisk().state)),persist:()=>true})
  assert.equal(restarted.lifeSnapshot(k.sessionId, {...defaultConfig(), sleepJitter:0,wakeJitter:0}, k.now()).life.facts[0].text, 'Owns the novel')
  assert.match(k.promptOf('project-karen-life'), /Owns the novel/)
  await k.tickAndSettle()
  assert.equal(calls, 2)
  assert.equal(secondInput.life.recent.at(-1).id, activity.id)
  assert.equal(secondInput.life.facts[0].text, 'Owns the novel')
} finally { k.stop() }

const cfg = { ...defaultConfig(), sleepStart:'23:00', wakeStart:'07:00', sleepJitter:0, wakeJitter:0 }
const anchors = Array.from({ length: 45 }, (_, i) => ({ id:'anchor-'+i, label:'Commitment '+i, startAt:at+(i+1)*86400000, endAt:at+(i+1)*86400000+3600000 }))
anchors.push({ id:'overdue', label:'Unresolved appointment', startAt:at-7200000, endAt:at-3600000 })
const state = { s:{life:{ activities:[{id:'in-progress',label:'Work',status:'in_progress',startAt:at-60000,startedAt:at-60000,endAt:at+60000}], anchors, facts:[] }} }
let disk
const timeline = new SessionTimeline({state,persist:()=>{disk=JSON.stringify(state);return true}})
let snap = timeline.lifeSnapshot('s', cfg, at)
assert.throws(() => timeline.saveLifePlan('s', { resolution:{id:'in-progress',status:'completed',reason:'time passed',confirmation:{kind:'karen_action',activityId:'in-progress',callId:'forged'}},activities:[] }, {now:at,windowEnd:at+10800000,revision:snap.revision}), /explicit resolution/)
assert.equal(state.s.life.activities[0].status, 'in_progress')
timeline.saveLifePlan('s',{resolution:{id:'in-progress',status:'postponed',reason:'Needs time'},activities:[]},{now:at,windowEnd:at+10800000,revision:snap.revision})
assert.equal(state.s.life.anchors.length,46)
assert.equal(planningContext(state.s.life,at).anchors.length,26)
const restarted = new SessionTimeline({state:JSON.parse(disk),persist:()=>true})
snap = restarted.lifeSnapshot('s',cfg,at)
assert.equal(snap.life.anchors.length,46)
assert.ok(snap.life.anchors.some(a=>a.id==='overdue'))
console.log('explicit completion and commitment retention: ok')

const appointmentState={s:{life:{activities:[{id:'visit',label:'Appointment',status:'in_progress',startAt:at,startedAt:at,endAt:at+3600000}],anchors:[{id:'anchor-visit',label:'Appointment',startAt:at,endAt:at+3600000}],facts:[]}}}
const appointmentTimeline=new SessionTimeline({state:appointmentState,persist:()=>true})
appointmentTimeline.completeAction('s','visit','Appointment',[],'tool-call',at+60000,cfg)
assert.equal(appointmentState.s.life.anchors[0].status,'completed')
assert.equal(appointmentState.s.life.anchors[0].activityId,'visit')
// Commitments established later the same day can be added without rewriting the first.
const laterState={s:{life:{activities:[],anchors:[],facts:[]}}}
const later=new SessionTimeline({state:laterState,persist:()=>true})
let laterView=later.lifeSnapshot('s',cfg,at)
later.saveLifePlan('s',{activities:[],anchors:[{label:'First appointment',startAt:at+3600000,endAt:at+7200000}]},{now:at,windowEnd:at+10800000,revision:laterView.revision})
laterView=later.lifeSnapshot('s',cfg,at+1000)
later.saveLifePlan('s',{activities:[],anchors:[{label:'Second appointment',startAt:at+10800000,endAt:at+14400000}]},{now:at+1000,windowEnd:at+10800000,revision:laterView.revision})
assert.deepEqual(laterState.s.life.anchors.map(a=>a.label),['First appointment','Second appointment'])
laterView=later.lifeSnapshot('s',cfg,at+2000)
assert.throws(()=>later.saveLifePlan('s',{activities:[],anchors:[{label:'First appointment',startAt:at+4000000,endAt:at+7300000}]},{now:at+2000,windowEnd:at+10800000,revision:laterView.revision}),/explicit resolution/)
assert.equal(laterState.s.life.anchors.length,2)
