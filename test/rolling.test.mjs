import assert from 'node:assert/strict'
import { startKaren } from './harness.mjs'
import { defaultConfig, normalizeConfig } from '../dsh/store.js'
import { LifePlanner, lifeOf, selectConversation } from '../dsh/life.mjs'

assert.equal(defaultConfig().planningHorizonMinutes, 180)
assert.equal(normalizeConfig({ planningHorizonMinutes: 75 }).planningHorizonMinutes, 75)
assert.equal(selectConversation([{type:'user/message', data:{role:'user',source:{kind:'user'},content:[{type:'text',text:'hello'}]}}]).conversation[0].text, 'hello')
let calls = 0, finish
const mock = { async *stream(options) {
  calls++
  assert.equal(options.messages.at(-1).source.kind, 'plugin:project-karen')
  const input = JSON.parse(options.messages[0].content[0].text)
  assert.equal(input.windowEnd - input.now, 180 * 60000)
  assert.ok(input.schedulerClock.now && input.schedulerClock.windowEnd && input.schedulerClock.timeZone)
  const activity = {label: 'Read a novel', startAt: input.now, endAt: input.now + 60 * 60000}
  yield {type:'text-delta', text:JSON.stringify({anchors:[],activities:input.life.current.length ? [] : [activity],resolution:input.life.current.length ? {id:input.life.current[0].id,status:'postponed',reason:'Needs more time'} : null})}
  yield {type:'finish',reason:{kind:'stop'}}
} }
const k = await startKaren({ startAt: new Date(2026, 9, 2, 9).getTime(), config:{sleepJitter:0,wakeJitter:0,weatherEnabled:false,greetEnabled:false,talkEnabled:false}, llm:mock })
try {
  await k.tickAndSettle()
  assert.equal(calls, 1)
  assert.equal(k.readDisk().state[k.sessionId].life.activities[0].status, 'planned')
  await k.tickAndSettle()
  assert.equal(k.readDisk().state[k.sessionId].life.activities[0].status, 'in_progress')
  assert.equal(calls, 1)
  assert.ok(k.promptOf('project-karen-action').includes('Read a novel'))
  k.advance(61*60000)
  await k.tickAndSettle()
  assert.equal(calls, 2)
  assert.equal(k.readDisk().state[k.sessionId].life.activities[0].status, 'postponed')
} finally { k.stop() }
let time=1000, resolves
const life=lifeOf({})
let state={life,revision:0,phase:'awake',sleepAtMs:1000000}
const planner=new LifePlanner({now:()=>time,read:()=>state,save:()=>{finish=true},generate:()=>new Promise(r=>{resolves=r})})
const first=planner.tick('a',{planningHorizonMinutes:3})
assert.equal(await planner.tick('a',{planningHorizonMinutes:3}),false)
state={...state,phase:'asleep',revision:1}
resolves({activities:[]})
assert.equal(await first,false)
assert.equal(finish,undefined)
console.log('rolling scheduler: ok')

// Exercise timeline persistence and the authoritative sleep/wake transition.
const { SessionTimeline } = await import('../dsh/session.mjs')
const cfg = { ...defaultConfig(), sleepStart:'23:00', wakeStart:'07:00', sleepJitter:0, wakeJitter:0 }
const start = new Date(2026, 9, 2, 22, 0).getTime()
let disk = '{}'
const records = { s: { action:{label:'Reading',startedAt:start-1000,endsAt:start+900000} } }
let timeline = new SessionTimeline({state:records,persist:()=>{disk=JSON.stringify(records); return true}})
let view = timeline.lifeSnapshot('s',cfg,start)
assert.equal(view.life.activities[0].status, 'in_progress')
assert.equal(records.s.action,undefined)
timeline.advanceLife('s',cfg,start+60*60000)
assert.equal(records.s.life.activities[0].status,'postponed')
const reloaded=JSON.parse(disk)
timeline=new SessionTimeline({state:reloaded,persist:()=>true})
view=timeline.lifeSnapshot('s',cfg,start+61*60000)
assert.equal(view.phase,'asleep')
assert.equal(view.life.activities[0].status,'postponed')
timeline.advanceLife('s',cfg,start+10*3600000)
assert.equal(reloaded.s.life.needsReplan,true)

// Character context stays owned by DSH and the request goes through llm.stream.
const { generateLifePlan } = await import('../dsh/planner.mjs')
let request
const character='A host-provided character and memory section.'
const fakeAgent={session:{id:'s',requestHeader:()=>({config:{provider:'mock',model:'mock'}})},ctx:{systemPrompt:{assemble:async scope=>{assert.equal(scope.agent,fakeAgent);assert.equal(scope.scope,fakeAgent);return {sections:[{name:'companion:character-and-memory',text:character}]}}}}}
await generateLifePlan({async *stream(o){request=o;yield {type:'text-delta',text:'{"activities":[],"anchors":[]}'};yield {type:'finish',reason:{kind:'stop'}}}},fakeAgent,{background:'old duplicate',conversation:[]})
assert.ok(request.system.includes(character))
assert.equal(JSON.parse(request.messages[0].content[0].text).background,'')
assert.equal(request.messages[0].source.kind,'plugin:project-karen')
assert.deepEqual(request.tools,[])

// Multiple days with wake/sleep: no planning while asleep, no invented completion.
for (let day=0;day<3;day++) {
  const night=new Date(2026,9,3+day,23,30).getTime()
  timeline.advanceLife('s',cfg,night)
  view=timeline.lifeSnapshot('s',cfg,night)
  assert.equal(view.phase,'asleep')
  assert.ok(view.life.activities.every(a=>a.status!=='in_progress'))
  timeline.advanceLife('s',cfg,new Date(2026,9,4+day,8).getTime())
  assert.equal(timeline.lifeSnapshot('s',cfg,new Date(2026,9,4+day,8).getTime()).phase,'awake')
}

const overnightStart=new Date(2026,9,7,22).getTime()
const offlineState={offline:{action:{label:'Long project',startedAt:overnightStart,endsAt:overnightStart+4*3600000}}}
let offline=new SessionTimeline({state:offlineState,persist:()=>true})
offline.advanceLife('offline',cfg,overnightStart)
const copy=JSON.parse(JSON.stringify(offlineState))
offline=new SessionTimeline({state:copy,persist:()=>true})
offline.snapshot('offline',cfg,new Date(2026,9,8,8).getTime())
offline.advanceLife('offline',cfg,new Date(2026,9,8,8).getTime())
assert.equal(copy.offline.life.activities[0].status,'postponed')
assert.equal(copy.offline.life.activities[0].reason,'Offline across sleep')

// A plan is committed atomically: conflicting anchors and activity proposals
// leave the previous plan untouched, while an ongoing activity can continue.
const checkAt=new Date(2026,9,10,10).getTime()
const checkState={x:{}}
const check=new SessionTimeline({state:checkState,persist:()=>true})
let snap=check.lifeSnapshot('x',cfg,checkAt)
const initial={anchors:[{label:'Work',startAt:checkAt+3600000,endAt:checkAt+7200000}],activities:[{label:'Work',startAt:checkAt+3600000,endAt:checkAt+7200000}]}
check.saveLifePlan('x',initial,{now:checkAt,windowEnd:checkAt+10800000,sleepAt:checkAt+46800000,revision:snap.revision})
const before=JSON.stringify(checkState.x.life)
snap=check.lifeSnapshot('x',cfg,checkAt)
assert.throws(()=>check.saveLifePlan('x',{activities:[{label:'Shopping',startAt:checkAt+5400000,endAt:checkAt+6000000}]},{now:checkAt,windowEnd:checkAt+10800000,sleepAt:checkAt+46800000,revision:snap.revision}),/conflict/)
assert.equal(JSON.stringify(checkState.x.life),before)
assert.throws(()=>check.saveLifePlan('x',{activities:[]},{now:checkAt,windowEnd:checkAt+10800000,revision:snap.revision-1}),/stale/)

// While asleep even repeated heartbeat triggers do not make a model call.
let sleepCalls=0
const sleeping=await startKaren({startAt:new Date(2026,9,2,23,30).getTime(),config:{sleepJitter:0,wakeJitter:0,weatherEnabled:false,greetEnabled:false,talkEnabled:false},llm:{async *stream(){sleepCalls++;yield {type:'text-delta',text:'{\"activities\":[],\"anchors\":[]}'};yield {type:'finish',reason:{kind:'stop'}}}}})
try {
  await sleeping.tickAndSettle(); await sleeping.tickAndSettle()
  assert.equal(sleepCalls,0)
  sleeping.advance(9*3600000)
  await sleeping.tickAndSettle()
  assert.equal(sleepCalls,1)
} finally {sleeping.stop()}
let plannedWindow
const horizonLife=lifeOf({})
const horizonState={life:horizonLife,revision:0,phase:'awake',sleepAtMs:100000000}
const horizonPlanner=new LifePlanner({now:()=>1000,read:()=>horizonState,save:()=>{},generate:async input=>{plannedWindow=input.windowEnd-input.now;return {activities:[]}}})
assert.equal(await horizonPlanner.tick('h',{planningHorizonMinutes:75}),true)
assert.equal(plannedWindow,75*60000)
const workId=checkState.x.life.activities[0].id
const anchorId=checkState.x.life.anchors[0].id
snap=check.lifeSnapshot('x',cfg,checkAt)
check.saveLifePlan('x',{changes:[{id:workId,status:'cancelled',reason:'Office closed'}],anchorChanges:[{id:anchorId,status:'cancelled',reason:'Office closed'}],activities:[{label:'Shopping',startAt:checkAt+5400000,endAt:checkAt+6000000}]},{now:checkAt,windowEnd:checkAt+10800000,sleepAt:checkAt+46800000,revision:snap.revision})
assert.equal(checkState.x.life.activities.find(a=>a.id===workId).status,'cancelled')
assert.equal(checkState.x.life.anchors.find(a=>a.id===anchorId).status,'cancelled')
// A temporary wake that lasts through the normal wake time stays awake.
const daySleep=new Date(2026,9,12,23).getTime()
const dayWake=new Date(2026,9,13,7).getTime()
const stirred=dayWake-10*60000
const stirredState={s:{sleepAtMs:daySleep,wakeAtMs:dayWake,nightKey:'23:00|0|07:00|0',awakeUntilMs:dayWake+20*60000,stirredAtMs:stirred,life:{activities:[{id:'awake-work',label:'Tea',status:'in_progress',startAt:stirred,startedAt:stirred,endAt:dayWake+10*60000}],anchors:[],facts:[]}}}
const stirredTimeline=new SessionTimeline({state:stirredState,persist:()=>true})
stirredTimeline.snapshot('s',cfg,dayWake+1000)
assert.equal(stirredState.s.life.activities[0].status,'in_progress')
