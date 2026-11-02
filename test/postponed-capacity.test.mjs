import assert from 'node:assert/strict'
import { addPlan, lifeOf, planningContext, MAX_UNRESOLVED_ACTIVITIES } from '../dsh/life.mjs'
import { SessionTimeline } from '../dsh/session.mjs'
import { defaultConfig } from '../dsh/store.js'
const at=new Date(2026,9,2,10).getTime(), horizon=at+180*60000
const postponed=Array.from({length:MAX_UNRESOLVED_ACTIVITIES},(_,i)=>({id:'p'+i,label:'Unfinished '+i,status:'postponed',startAt:at-7200000,endAt:at-3600000,endedAt:at-3000000,reason:'Deferred'}))
const state={s:{life:{activities:postponed,anchors:[{id:'anchor',label:'Unfinished 0',startAt:at+86400000,endAt:at+90000000}],facts:[]}}}
const cfg={...defaultConfig(),sleepStart:'23:00',wakeStart:'07:00',sleepJitter:0,wakeJitter:0}
const timeline=new SessionTimeline({state,persist:()=>true})
let snapshot=timeline.lifeSnapshot('s',cfg,at)
assert.equal(planningContext(snapshot.life,at).availableActivitySlots,0)
assert.ok(planningContext(snapshot.life,at).olderPostponed.some(a=>a.id==='p0'))
const before=JSON.stringify(state.s.life)
assert.throws(()=>timeline.saveLifePlan('s',{activities:[{label:'New',startAt:at,endAt:at+60000}]},{now:at,windowEnd:horizon,revision:snapshot.revision}),/capacity/)
assert.equal(JSON.stringify(state.s.life),before)
// Explicitly resolving a deferred record frees exactly one slot; anchors remain.
timeline.saveLifePlan('s',{changes:[{id:'p1',status:'cancelled',reason:'No longer needed'}],activities:[{label:'New',startAt:at,endAt:at+60000}]},{now:at,windowEnd:horizon,revision:snapshot.revision})
assert.equal(state.s.life.activities.find(a=>a.id==='p1').status,'cancelled')
assert.equal(state.s.life.anchors[0].id,'anchor')
assert.equal(state.s.life.activities.filter(a=>['planned','in_progress','postponed'].includes(a.status)).length,MAX_UNRESOLVED_ACTIVITIES)
// Resuming uses the same identity, retains the prior postponement, and cannot
// cross another activity or the sleep boundary.
snapshot=timeline.lifeSnapshot('s',cfg,at)
assert.throws(()=>timeline.saveLifePlan('s',{changes:[{id:'p0',status:'resume',startAt:at,endAt:at+30000,reason:'Continue'}],activities:[]},{now:at,windowEnd:horizon,revision:snapshot.revision}),/conflict/)
timeline.saveLifePlan('s',{changes:[{id:'p0',status:'resume',startAt:at+120000,endAt:at+180000,reason:'Continue'}],activities:[]},{now:at,windowEnd:horizon,revision:snapshot.revision})
const resumed=state.s.life.activities.find(a=>a.id==='p0')
assert.equal(resumed.status,'planned');assert.equal(resumed.previousPostponement.reason,'Deferred')
// Oversized legacy state is never silently truncated, and new records cannot
// make the backlog larger until explicit resolutions reduce it.
const legacy=lifeOf({});legacy.activities=Array.from({length:MAX_UNRESOLVED_ACTIVITIES+8},(_,i)=>({id:'old'+i,label:'Old '+i,status:'postponed'}))
assert.throws(()=>addPlan(legacy,[{label:'New',startAt:at,endAt:at+60000}],{now:at,windowEnd:horizon}),/capacity/)
assert.equal(legacy.activities.length,MAX_UNRESOLVED_ACTIVITIES+8)
const sleepSnapshot=timeline.lifeSnapshot('s',cfg,at)
assert.throws(()=>timeline.saveLifePlan('s',{changes:[{id:'p2',status:'resume',startAt:at+240000,endAt:at+300000,reason:'Continue'}],activities:[]},{now:at,windowEnd:horizon,sleepAt:at+270000,revision:sleepSnapshot.revision}),/interval/)
assert.equal(state.s.life.activities.find(a=>a.id==='p2').status,'postponed')
const oversized={s:{life:{activities:legacy.activities,anchors:[],facts:[]}}}
const largeTimeline=new SessionTimeline({state:oversized,persist:()=>true})
const largeView=largeTimeline.lifeSnapshot('s',cfg,at)
largeTimeline.saveLifePlan('s',{activities:[]},{now:at,windowEnd:horizon,revision:largeView.revision})
assert.equal(oversized.s.life.activities.length,MAX_UNRESOLVED_ACTIVITIES+8)
// Finishing the resumed activity frees capacity without deleting its history or
// resolving a separate appointment with the same label on another date.
timeline.advanceLife('s',cfg,at+120000)
timeline.advanceLife('s',cfg,at+120000)
assert.equal(state.s.life.activities.find(a=>a.id==='p0').status,'in_progress')
timeline.completeAction('s','p0','Unfinished 0',[],'confirmation',at+120000,cfg)
assert.equal(planningContext(state.s.life,at+120000).availableActivitySlots,1)
assert.equal(state.s.life.anchors[0].id,'anchor')
assert.equal(state.s.life.anchors[0].status,undefined)
assert.equal(state.s.life.activities.find(a=>a.id==='p1').previousPostponement.reason,'Deferred')
// Resolved history is pruned separately while the unresolved postponed record stays.
const historyState={s:{life:{activities:[...Array.from({length:205},(_,i)=>({id:'done'+i,label:'Done '+i,status:'cancelled'})),{id:'still-open',label:'Still open',status:'postponed'}],anchors:[],facts:[]}}}
const historyTimeline=new SessionTimeline({state:historyState,persist:()=>true})
const historyView=historyTimeline.lifeSnapshot('s',cfg,at)
historyTimeline.saveLifePlan('s',{activities:[]},{now:at,windowEnd:horizon,revision:historyView.revision})
assert.equal(historyState.s.life.activities.filter(a=>a.status==='cancelled').length,200)
assert.ok(historyState.s.life.activities.some(a=>a.id==='still-open' && a.status==='postponed'))


// The 20-second heartbeat alone must not rewrite a stable state file.
let writes=0
const quietState={s:{life:{activities:Array.from({length:MAX_UNRESOLVED_ACTIVITIES},(_,i)=>({id:'quiet'+i,label:'Deferred '+i,status:'postponed'})),anchors:[],facts:[]}}}
const quietTimeline=new SessionTimeline({state:quietState,persist:()=>{writes++}})
const quietCfg={...cfg,greetEnabled:false,talkEnabled:false,actionEnabled:false}
quietTimeline.advanceLife('s',quietCfg,at);quietTimeline.due('s',quietCfg,at)
writes=0
for(let i=1;i<=180;i++){const tickAt=at+i*20000;quietTimeline.advanceLife('s',quietCfg,tickAt);quietTimeline.due('s',quietCfg,tickAt)}
assert.equal(writes,0)

// A resumed activity cannot displace an unrelated retained commitment.
const anchorState={s:{life:{activities:[{id:'deferred',label:'Exercise',status:'postponed',startAt:at-100000,endAt:at-50000,reason:'Deferred'}],anchors:[{id:'appointment',label:'Appointment',startAt:at+600000,endAt:at+1200000}],facts:[]}}}
const anchorTimeline=new SessionTimeline({state:anchorState,persist:()=>true})
const anchorView=anchorTimeline.lifeSnapshot('s',cfg,at)
assert.throws(()=>anchorTimeline.saveLifePlan('s',{changes:[{id:'deferred',status:'resume',startAt:at+700000,endAt:at+800000,reason:'Continue'}],activities:[]},{now:at,windowEnd:horizon,revision:anchorView.revision}),/anchor/)
assert.equal(anchorState.s.life.activities[0].status,'postponed')
assert.equal(anchorState.s.life.anchors[0].id,'appointment')
console.log('postponed capacity and resolution: ok')
