import assert from 'node:assert/strict'
import { generateLifePlan, parsePlanObject, planShapeProblem } from '../dsh/planner.mjs'

// 真模型不会老老实实只吐 JSON —— 这些用例覆盖它跑偏时的每一种样子。
const agent = {
  session: { id: 's', requestHeader: () => ({ config: { provider: 'mock', model: 'mock' } }) },
  ctx: {},
}
const input = {
  now: 1000, windowEnd: 5000, conversation: [], background: '',
  life: { current: [], future: [], recent: [], anchors: [], facts: [], availableActivitySlots: 200 },
}

// ── 解析层 ──
assert.deepEqual(parsePlanObject('{"activities":[],"anchors":[]}'), { activities: [], anchors: [] })
assert.deepEqual(parsePlanObject('\u0060\u0060\u0060json\n{"activities":[]}\n\u0060\u0060\u0060'), { activities: [] })
assert.deepEqual(parsePlanObject('好的，我安排一下。\n{"activities":[],"anchors":[]}\n以上。'), { activities: [], anchors: [] })
assert.deepEqual(parsePlanObject('{"activities":[{"label":"写 { 一段 } 代码"}]}'), { activities: [{ label: '写 { 一段 } 代码' }] })
assert.equal(parsePlanObject('收到。先确认一下你的需求。'), null)

// ── 结构层：镜像 saveLifePlan 的硬性要求 ──
assert.equal(planShapeProblem({ activities: [] }, input), null)
assert.match(planShapeProblem({}, input), /activities must be an array/)
assert.match(planShapeProblem({ activities: new Array(13).fill({}) }, input), /limit is 12/)
assert.match(planShapeProblem({ activities: [], changes: new Array(13).fill({}) }, input), /changes must be/)
assert.match(planShapeProblem({ activities: [], anchorChanges: new Array(7).fill({}) }, input), /anchorChanges must be/)
const withCurrent = { ...input, life: { ...input.life, current: [{ id: 'a', status: 'in_progress' }] } }
assert.match(planShapeProblem({ activities: [] }, withCurrent), /resolution is required/)
assert.match(planShapeProblem({ activities: [], resolution: { status: 'completed' } }, withCurrent), /resolution.status must be/)

// ── 重试层 ──
let call = 0
const proseThenJson = { async *stream (options) {
  call += 1
  assert.equal(options.messages.at(-1).source.kind, 'plugin:project-karen')
  if (call === 1) yield { type: 'text-delta', text: '收到。先确认一下你要我做什么。' }
  else {
    assert.equal(options.messages.length, 1, '纠正请求用单条 user 消息（宿主已验证的形状）')
    assert.ok(options.messages[0].content[0].text.includes('收到'), '纠正请求应带上原回复')
    yield { type: 'text-delta', text: '{"activities":[],"anchors":[]}' }
  }
  yield { type: 'finish', reason: { kind: 'stop' } }
} }
assert.deepEqual(await generateLifePlan(proseThenJson, agent, input), { activities: [], anchors: [] })
assert.equal(call, 2)

// 结构不合法（activities 超限）也应当纠正重试，而不是丢给保存层
let shapes = 0
const tooMany = { async *stream (options) {
  shapes += 1
  if (shapes === 1) {
    const many = Array.from({ length: 20 }, (_, i) => ({ label: 'x' + i, startAt: i, endAt: i + 1 }))
    yield { type: 'text-delta', text: JSON.stringify({ activities: many, anchors: [] }) }
  } else {
    assert.ok(options.messages[0].content[0].text.includes('limit is 12'), '纠正提示应说明具体问题')
    yield { type: 'text-delta', text: '{"activities":[],"anchors":[]}' }
  }
  yield { type: 'finish', reason: { kind: 'stop' } }
} }
assert.deepEqual(await generateLifePlan(tooMany, agent, input), { activities: [], anchors: [] })
assert.equal(shapes, 2)

// 两次都不合格 -> 报错必须带上原因与原文片段
const alwaysProse = { async *stream () {
  yield { type: 'text-delta', text: '我还是先聊两句天吧。' }
  yield { type: 'finish', reason: { kind: 'stop' } }
} }
await assert.rejects(() => generateLifePlan(alwaysProse, agent, input), /Planning output rejected \(the reply is not a JSON object\):.*聊两句/)

// 正常 JSON 只调一次模型
let once = 0
const clean = { async *stream () {
  once += 1
  yield { type: 'text-delta', text: '{"activities":[],"anchors":[]}' }
  yield { type: 'finish', reason: { kind: 'stop' } }
} }
await generateLifePlan(clean, agent, input)
assert.equal(once, 1)

// 载荷整形：对话不能以数组形式喂给模型，否则它会把对话当成要续写的内容
let payload
const peek = { async *stream (options) {
  payload = JSON.parse(options.messages[0].content[0].text)
  yield { type: 'text-delta', text: '{"activities":[],"anchors":[]}' }
  yield { type: 'finish', reason: { kind: 'stop' } }
} }
await generateLifePlan(peek, agent, { ...input, conversation: [{ role: 'user', text: '我要出门了' }] })
assert.ok(payload.task, '载荷应带任务说明')
assert.equal(payload.conversation, undefined, 'conversation 不应再以数组形式出现')
assert.ok(String(payload.conversationLog).includes('我要出门了'), '对话应摊平进 conversationLog')
assert.equal(payload.life.current.length, 0, 'life 透传不受影响')

console.log('planner output format: ok')
