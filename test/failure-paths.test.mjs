import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LifePlanner, lifeOf } from '../dsh/life.mjs'
import { SessionTimeline } from '../dsh/session.mjs'
import { Store, defaultConfig } from '../dsh/store.js'

// Failure schedules one retry after five minutes; no early call is admitted.
let clock=1000000, calls=0, saves=0
const life=lifeOf({})
const state={life,revision:0,phase:'awake',sleepAtMs:clock+86400000}
const planner=new LifePlanner({now:()=>clock,read:()=>state,save:()=>{saves++},generate:async()=>{calls++;if(calls===1)throw Error('mock provider failure');return {activities:[]}}})
const config={planningHorizonMinutes:180}
await assert.rejects(planner.tick('s',config),/mock provider failure/)
assert.equal(calls,1);assert.equal(saves,0)
clock+=299999
assert.equal(await planner.tick('s',config),false);assert.equal(calls,1)
clock++
assert.equal(await planner.tick('s',config),true);assert.equal(calls,2);assert.equal(saves,1)
assert.equal(planner.retry.has('s'),false)

// A real filesystem error during the atomic write leaves both the old file and
// the authoritative in-memory record unchanged for plan and confirmation.
const dir=mkdtempSync(path.join(tmpdir(),'karen-write-failure-'))
try {
 const file=path.join(dir,'state.json'),warnings=[]
 const store=new Store({filePath:file,logger:{warn:m=>warnings.push(m)}})
 const at=new Date(2026,9,2,10).getTime()
 const cfg={...defaultConfig(),sleepStart:'23:00',wakeStart:'07:00',sleepJitter:0,wakeJitter:0}
 store.state.s={life:{activities:[{id:'current',label:'Read',status:'in_progress',startAt:at-60000,startedAt:at-60000,endAt:at+60000}],anchors:[],facts:[]}}
 const timeline=new SessionTimeline({state:store.state,persist:()=>store.persist()})
 const snapshot=timeline.lifeSnapshot('s',cfg,at)
 assert.equal(store.persist(),true)
 const diskBefore=readFileSync(file,'utf8'),lifeBefore=JSON.stringify(store.state.s.life)
 mkdirSync(file+'.tmp') // writeFileSync fails before rename; previous file stays intact.
 assert.throws(()=>timeline.saveLifePlan('s',{resolution:{id:'current',status:'postponed',reason:'Pause'},activities:[]},{now:at,windowEnd:at+3600000,revision:snapshot.revision}),/could not persist plan/)
 assert.equal(JSON.stringify(store.state.s.life),lifeBefore)
 assert.equal(readFileSync(file,'utf8'),diskBefore)
 assert.throws(()=>timeline.completeAction('s','current','Read',['Owns a novel'],'tool-call',at,cfg),/could not persist activity confirmation/)
 assert.equal(JSON.stringify(store.state.s.life),lifeBefore)
 assert.equal(readFileSync(file,'utf8'),diskBefore)
 assert.equal(warnings.length,2)
} finally {rmSync(dir,{recursive:true,force:true})}

// There is no wall-clock fallback that could ignore the configured offset.
const offsetState={s:{life:{activities:[{id:'active',label:'Read',status:'in_progress',startAt:100,startedAt:100,endAt:200}],anchors:[],facts:[]}}}
const offsetTimeline=new SessionTimeline({state:offsetState,persist:()=>true})
assert.throws(()=>offsetTimeline.takeAction('s'),/activity time is required/)
offsetTimeline.takeAction('s',123456)
assert.equal(offsetState.s.life.activities[0].endedAt,123456)
let saveClock=2000000, saveCalls=0, generated=0
const saveState={life:lifeOf({}),revision:0,phase:'awake',sleepAtMs:saveClock+86400000}
const failedSavePlanner=new LifePlanner({now:()=>saveClock,read:()=>saveState,generate:async()=>{generated++;return {activities:[]}},save:()=>{saveCalls++;if(saveCalls===1)throw Error('mock write failed')}})
await assert.rejects(failedSavePlanner.tick('save',config),/mock write failed/)
saveClock+=299999;assert.equal(await failedSavePlanner.tick('save',config),false)
assert.equal(generated,1)
saveClock++;assert.equal(await failedSavePlanner.tick('save',config),true)
assert.equal(saveCalls,2);assert.equal(generated,2)
// The actual debug endpoint supplies the configured offset-aware timestamp.
const { startKaren } = await import('./harness.mjs')
const start=new Date(2026,9,2,9).getTime()
const fake={async *stream(options){const input=JSON.parse(options.messages[0].content[0].text);yield {type:'text-delta',text:JSON.stringify({activities:[{label:'Offset activity',startAt:input.now,endAt:input.now+1800000}],anchors:[]})};yield {type:'finish',reason:{kind:'stop'}}}}
const k=await startKaren({startAt:start,config:{offsetMinutes:60,sleepJitter:0,wakeJitter:0,weatherEnabled:false,greetEnabled:false,talkEnabled:false},llm:fake})
try {
 await k.tickAndSettle();await k.tickAndSettle()
 await k.request('POST','/project-karen/debug',{action:'end-action',sessionId:k.sessionId})
 const activity=k.readDisk().state[k.sessionId].life.activities[0]
 assert.equal(activity.status,'interrupted')
 assert.equal(activity.endedAt,k.now()+60*60000)
} finally {k.stop()}

console.log('failure, retry and clock paths: ok')
