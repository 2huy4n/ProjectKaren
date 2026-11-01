// Uses the public DSH package entry points and a synthetic scoped agent.
import assert from 'node:assert/strict'
import { generateLifePlan } from '../dsh/planner.mjs'
const mod=async name=>import('@deepseek-ai/'+name)
const {Context}=await mod('cordis')
const ctx=new Context()
try {
  for (const name of ['dsh-session','dsh-agent','dsh-session-projection','dsh-llm','dsh-system-prompt','dsh-tools','dsh-attachment','dsh-agent-loop']) await ctx.plugin((await mod(name)).default,{}).inertia
  const character='HOST CHARACTER AND MEMORY — synthetic fixture'
  const handle = await ctx.agents.create({sessionId:'scope-fixture',agentOptions:{provider:'mock',model:'mock'},setup:scoped => { scoped.systemPrompt.section({name:'companion:character-and-memory',order:0,text:character,interpolate:false}) }})
  let admitted=0
  ctx.on('llm/stream',async function* (options) {
    admitted++
    assert.ok(options.system.includes(character))
    assert.equal(options.messages.at(-1).source.kind,'plugin:project-karen')
    assert.deepEqual(options.tools,[])
    yield {type:'text-delta',index:0,text:'{"activities":[],"anchors":[]}'}
    yield {type:'finish',reason:{kind:'stop'}}
  })
  const agent=handle.agent
  const result=await generateLifePlan(ctx.llm,agent,{now:1000,windowEnd:5000,conversation:[],background:''})
  assert.deepEqual(result,{activities:[],anchors:[]})
  assert.equal(admitted,1)
  await handle.dispose()
  console.log('installed scoped DSH system prompt and llm middleware: ok')
} finally { await ctx.fiber.dispose() }
