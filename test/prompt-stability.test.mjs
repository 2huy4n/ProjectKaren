#!/usr/bin/env node
// 注入通道的不变量：会变的数字只许出现在运行时上下文里，分节只在状态翻转时才变。
//
// 背景（用户报的 issue）：睡眠文案里有「还有 XX 分钟会醒」，动作文案里有「已经过去 /
// 还剩 XX 分钟」—— 每分钟变一次。而系统提示词在请求最前面，DeepSeek 是前缀缓存：
// 前面一变，从那里往后的整段历史全部按未命中价重算。
//
// 修法不是「把整块都挪进上下文」，而是按变化频率切开：
//   · 分节（系统提示词）：「你现在在睡觉 / 你正在做饭」+ 规矩 —— 只在入睡、醒来、
//     开工、收工那一分钟变。
//   · 上下文（追加在已缓存历史之后的快照）：只剩倒计时那几个数字，每分钟变。
// 为什么分节不能整块搬走：部署方（或 agent preset）可以 includeRuntimeContext:false
// 把运行时上下文整体关掉，那时至少「她在睡觉，别回应内容」这条规矩得留下。
//
// 这个文件测的就是上面这套分工，外加两条边界：
//   A. 被抑制的部署里，分节仍然交代状态与规矩，只是没有分钟数。
//   B. 只填了「用户城市」时，主城市取它，天气照样取到（不再反过来告诉模型"取不到"）。
//
// 用法：npm test
import { startKaren } from './harness.mjs'

let pass = 0
const failures = []
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \u2713 ${name}`) }
  else { failures.push(`${name}${extra ? '  →  ' + extra : ''}`); console.log(`  \u2717 ${name}${extra ? '  →  ' + extra : ''}`) }
}

async function withKaren(opts, fn) {
  const karen = await startKaren(opts)
  try { return await fn(karen) } finally { karen.stop() }
}

const MIN = 60000
/** 2026 年 10 月 day 日 hh:mm（本地时区）。 */
const at = (hh, mm = 0, day = 3) => new Date(2026, 9, day, hh, mm, 0, 0).getTime()

// 模糊区间归零、主动行为全关：让阶段切换与分钟数变化都只由假时钟决定。
const FIXED = {
  sleepStart: '23:00', sleepJitter: 0,
  wakeStart: '07:00', wakeJitter: 0,
  greetEnabled: false, greetNoonEnabled: false,
  talkEnabled: false, actionEnabled: false,
  weatherEnabled: false,
}

/** 模型看到的系统提示词那半边的完整形态（名字 + 文本）；一变就说明前缀要重算。 */
const sectionShape = (karen) => karen.prompts()
  .filter((item) => item.kind === 'section')
  .map((item) => item.name + '\u0000' + item.text)
  .join('\n')

console.log('\n1. 通道：倒计时走运行时上下文，状态与规矩留在系统提示词')
await withKaren({ startAt: at(14, 0), config: FIXED }, async (karen) => {
  const sections = [...karen.sections.keys()].sort().join(', ')
  const contexts = [...karen.contexts.keys()].sort().join(', ')
  check('分节三条：睡眠 / 动作 / 相机',
    sections === 'project-karen-action, project-karen-camera, project-karen-sleep', sections)
  check('上下文三条：动作倒计时 / 今天 / 睡眠倒计时',
    contexts === 'project-karen-action-clock, project-karen-context, project-karen-sleep-clock', contexts)
  check('上下文的顺序排在框架自带的 110/115/120 之后',
    [...karen.contexts.values()].every((spec) => spec.order > 120),
    [...karen.contexts.entries()].map(([n, s]) => `${n}=${s.order}`).join(', '))
})

console.log('\n2. 一整天逐分钟采样：同一状态内分节逐字节不变，倒计时照旧在跳')
await withKaren({ startAt: at(6, 0), config: FIXED }, async (karen) => {
  const shapes = new Set()
  const clockTexts = new Set()
  const violations = []
  let prevPhase = null
  let prevShape = null
  for (let i = 0; i < 24 * 60; i += 1) {
    const phase = (await karen.snapshot()).phase
    const shape = sectionShape(karen)
    shapes.add(shape)
    if (prevPhase !== null && phase === prevPhase && shape !== prevShape) violations.push(i)
    prevPhase = phase
    prevShape = shape
    const clock = karen.promptOf('project-karen-sleep-clock')
    if (clock) clockTexts.add(clock)
    karen.advance(MIN)
  }

  check('1440 次采样里，同一状态内分节 0 次变化',
    violations.length === 0, `违规 ${violations.length} 次，最早第 ${violations[0]} 分钟`)
  check('这一天里状态确实翻转过（否则上一条是空断言）', shapes.size === 2, `${shapes.size} 种形态`)
  check('睡眠倒计时照旧每分钟在变', clockTexts.size > 10, `${clockTexts.size} 种`)
  check('分节里没有倒计时（「还有约 …分钟」只在上下文里）',
    [...shapes].every((s) => !s.includes('还有约')), String([...shapes].find((s) => s.includes('还有约'))).slice(0, 80))
})

console.log('\n3. 自由动作全程：倒计时每分钟在变，分节只在开工/收工那两分钟变')
await withKaren({ startAt: at(14, 0), config: FIXED }, async (karen) => {
  const idleShape = sectionShape(karen)
  karen.tools.get('karen_action').execute({ label: '做饭', minutes: 30 }, { agent: karen.agent })
  const busyShape = sectionShape(karen)

  check('开工那一分钟分节确实变了（状态翻转）', busyShape !== idleShape)
  check('分节里有「你正在」，但没有倒计时',
    busyShape.includes('你正在') && !busyShape.includes('还剩约'), busyShape.slice(0, 80))

  const during = new Set()
  const clockTexts = new Set()
  for (let i = 0; i < 25; i += 1) {
    during.add(sectionShape(karen))
    const clock = karen.promptOf('project-karen-action-clock')
    if (clock) clockTexts.add(clock)
    karen.advance(MIN)
    await karen.tickAndSettle()
  }
  check('动作进行中 25 分钟分节逐字节不变', during.size === 1, `${during.size} 种`)
  check('动作倒计时每分钟在变', clockTexts.size > 10, `${clockTexts.size} 种`)
  check('倒计时里同时带着「开始于约」和「还剩约」',
    [...clockTexts].some((x) => x.includes('开始于约') && x.includes('还剩约')))

  for (let i = 0; i < 10; i += 1) { karen.advance(MIN); await karen.tickAndSettle() }
  check('收工后分节回到空闲形态', sectionShape(karen) === idleShape)
  check('收工后倒计时注入清空', karen.promptOf('project-karen-action-clock') === '',
    karen.promptOf('project-karen-action-clock').slice(0, 60))
})

console.log('\n4. 被抑制的部署（includeRuntimeContext:false）：倒计时没了，「她在睡觉」还在')
await withKaren({ startAt: at(23, 30), config: FIXED, runtimeContextSuppressed: true }, async (karen) => {
  const sleep = karen.promptOf('project-karen-sleep')
  check('睡眠分节仍然交给模型（退化的只是分钟数）',
    sleep.includes('你现在在睡觉') && sleep.includes('不要回应内容'), sleep.slice(0, 70))
  check('分节里带着这一觉的时刻，只是没有倒计时',
    sleep.includes('23:00') && sleep.includes('07:00') && !sleep.includes('还有约'), sleep.slice(0, 70))
  check('倒计时（运行时上下文）确实一条都不剩', karen.promptOf('project-karen-sleep-clock') === '')
  check('模型收到的注入里没有 context 条目',
    karen.prompts().every((item) => item.kind === 'section'),
    karen.prompts().map((item) => item.kind).join(', '))
})

console.log('\n5. 只填「用户城市」也能取到天气（主城市 = 角色城市 || 用户城市）')
const weatherCalls = []
const fakeWeather = (url) => {
  weatherCalls.push(url)
  if (url.includes('geocoding-api')) {
    return { ok: true, json: async () => ({ results: [{ name: '上海', country: '中国', latitude: 31.2, longitude: 121.5 }] }) }
  }
  return {
    ok: true,
    json: async () => ({
      current: { temperature_2m: 22.4, weather_code: 0, is_day: 1 },
      daily: { temperature_2m_max: [28.1], temperature_2m_min: [18.6] },
      timezone: 'Asia/Shanghai',
    }),
  }
}
await withKaren({
  startAt: at(14, 0),
  config: { ...FIXED, weatherEnabled: true, citySelf: '', cityUser: '上海' },
  fetchStub: fakeWeather,
}, async (karen) => {
  await karen.settle()
  await karen.settle()
  const today = karen.promptOf('project-karen-context')
  check('启动就取到了用户城市的天气', today.includes('上海'), today.slice(0, 90))
  check('不再反过来告诉模型「天气取不到」', !today.includes('取不到'), today.slice(0, 90))
  check('用户城市当主城市时只抓一次预报（不该抓两遍）',
    weatherCalls.filter((url) => url.includes('/forecast')).length === 1, weatherCalls.join(' | '))
})

console.log('\n6. 跨国庆那一天的采样：「今天的情况」会变，但它不在分节里')
await withKaren({ startAt: at(12, 0, 30), config: FIXED }, async (karen) => {
  const shapes = new Set()
  const todayTexts = new Set()
  for (let i = 0; i < 24 * 60; i += 1) {
    shapes.add(sectionShape(karen))
    todayTexts.add(karen.promptOf('project-karen-context'))
    karen.advance(MIN)
  }

  check('跨过 10-01 那一刻「今天的情况」确实变了（否则下面两条是空断言）',
    todayTexts.size >= 2, `${todayTexts.size} 种`)
  check('而分节仍然只有睡着/醒着两种形态（今天的情况留在上下文里）',
    shapes.size === 2, `${shapes.size} 种`)
  check('分节里没有混进节日文案',
    [...shapes].every((s) => !s.includes('国庆')), String([...shapes].find((s) => s.includes('国庆'))).slice(0, 80))
})

console.log('\n7. 老宿主兜底：没有 context() 时整块退回分节，注入不丢')
await withKaren({ startAt: at(23, 30), config: FIXED, legacyPromptService: true }, async (karen) => {
  const sleep = karen.promptOf('project-karen-sleep')
  check('睡眠文案还在（含倒计时，只是要付前缀缓存的钱）',
    sleep.includes('你现在在睡觉') && karen.promptOf('project-karen-sleep-clock').includes('还有约'),
    karen.promptOf('project-karen-sleep-clock').slice(0, 60))
  check('运行时上下文一个也没注册（老宿主没有这个 API）', karen.contexts.size === 0)
})

if (failures.length > 0) {
  console.log(`\n\u2717 ${failures.length} 项未通过（${pass} 项通过）\n`)
  process.exit(1)
}
console.log(`\n\u2713 全部通过（${pass} 项）\n`)
