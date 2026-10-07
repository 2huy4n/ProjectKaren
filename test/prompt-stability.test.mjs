#!/usr/bin/env node
// 前缀缓存稳定性：会变的数字只许出现在运行时上下文里，不许出现在系统提示词里。
//
// 背景（用户报的 issue）：睡眠文案里有「还有 XX 分钟会醒」，动作文案里有「已经过去 /
// 还剩 XX 分钟」—— 每分钟变一次。而系统提示词在请求最前面，DeepSeek 是前缀缓存：
// 前面一变，从那里往后的整段历史全部按未命中价重算。
//
// 这个文件不测「注入了什么」（那是 plugin-smoke 的事），测的是「注入通道选对了没有」：
//   1. 模拟一整天逐分钟采样 —— 系统提示词分节必须逐字节不变；
//   2. 同一批采样里分钟数照旧在运行时上下文里跳动 —— 功能没丢；
//   3. 三块逐请求事实注册在 contexts，静态的相机说明注册在 sections。
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

/** 系统提示词那一半的完整形态（名字 + 文本）；一变就说明前缀要重算。 */
const sectionShape = (karen) => karen.prompts()
  .filter((item) => item.kind === 'section')
  .map((item) => item.name + '\u0000' + item.text)
  .join('\n')

console.log('\n1. 通道：会变的事实走运行时上下文，静态能力说明留在系统提示词')
await withKaren({ startAt: at(14, 0), config: FIXED }, async (karen) => {
  const volatile = ['project-karen-sleep', 'project-karen-action', 'project-karen-context']
  check('睡眠/动作/今天三块都在 contexts 里',
    volatile.every((name) => karen.contexts.has(name)),
    [...karen.contexts.keys()].join(', '))
  check('而且都不在 sections 里',
    volatile.every((name) => !karen.sections.has(name)),
    [...karen.sections.keys()].join(', '))
  check('相机那条（静态）留在 sections 里',
    karen.sections.has('project-karen-camera') && !karen.contexts.has('project-karen-camera'))
  check('顺序排在框架自带的三条上下文（110/115/120）之后',
    volatile.every((name) => karen.contexts.get(name).order > 120),
    volatile.map((name) => `${name}=${karen.contexts.get(name).order}`).join(', '))
})

console.log('\n2. 一整天逐分钟采样：系统提示词逐字节不变，分钟数照旧在跳')
await withKaren({ startAt: at(6, 0), config: FIXED }, async (karen) => {
  const shapes = new Set()
  const sleepTexts = new Set()
  for (let i = 0; i < 24 * 60; i += 1) {
    shapes.add(sectionShape(karen))
    const sleep = karen.promptOf('project-karen-sleep')
    if (sleep) sleepTexts.add(sleep)
    karen.advance(MIN)
  }

  check('这一天里确实睡着过（否则下面两条断言是空的）', sleepTexts.size > 1, `${sleepTexts.size} 段睡眠文案`)
  check('睡眠文案里的分钟数照旧每分钟在变', sleepTexts.size > 10, `${sleepTexts.size} 种`)
  check('24 小时里系统提示词只有一种形态', shapes.size === 1, `${shapes.size} 种形态`)
  check('系统提示词里没有分钟数', ![...shapes][0].includes('分钟'), String([...shapes][0]).slice(0, 160))
})

console.log('\n3. 自由动作全程：语境每分钟在变，系统提示词纹丝不动')
await withKaren({ startAt: at(14, 0), config: FIXED }, async (karen) => {
  const before = sectionShape(karen)
  karen.tools.get('karen_action').execute({ label: '做饭', minutes: 30 }, { agent: karen.agent })

  const shapes = new Set()
  const actionTexts = new Set()
  for (let i = 0; i < 35; i += 1) {
    shapes.add(sectionShape(karen))
    const action = karen.promptOf('project-karen-action')
    if (action) actionTexts.add(action)
    karen.advance(MIN)
    await karen.tickAndSettle()
  }

  check('动作文案里有「开始于约 / 还剩约」两种分钟数', actionTexts.size > 1, `${actionTexts.size} 种`)
  check('动作进行中系统提示词没变过', shapes.size === 1 && [...shapes][0] === before, `${shapes.size} 种`)
  check('动作到点后不再注入处境', karen.promptOf('project-karen-action') === '',
    karen.promptOf('project-karen-action').slice(0, 60))
})

console.log('\n4. 老宿主兜底：没有 context() 时退回分节，注入不丢')
await withKaren({ startAt: at(23, 30), config: FIXED, legacyPromptService: true }, async (karen) => {
  check('睡眠文案还在（只是走分节、要付缓存的钱）',
    karen.sections.has('project-karen-sleep') && karen.promptOf('project-karen-sleep').length > 0)
  check('运行时上下文一个也没注册（老宿主没有这个 API）', karen.contexts.size === 0)
})

if (failures.length > 0) {
  console.log(`\n\u2717 ${failures.length} 项未通过（${pass} 项通过）\n`)
  process.exit(1)
}
console.log(`\n\u2713 全部通过（${pass} 项）\n`)
