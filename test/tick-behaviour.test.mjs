#!/usr/bin/env node
// tick 的行为特征测试 —— 把「搬家之前她是怎么动的」逐条钉死。
//
// 目的不是审判现状，而是给后面的重构装一个探测器：候选 1（状态合并）与候选 2
// （调度策略抬出）都宣称「行为不变」，这些断言就是那句话的证据。所以这里**照实
// 记录**当前实现的行为，看着可疑的地方也照记，可疑之处在断言名里点出来。
//
// 两处已知的可疑行为，本文件刻意把它们钉成事实（而不是修饰成「应该的样子」）：
//   1. 「午安」被「打招呼」总开关罩着 —— 面板上两个独立开关，实现上并不独立。
//   2. say() 的日志写在 .then() 里，是异步的；投递却是同步的。断言日志前必须
//      await tickAndSettle()，否则读到的是一条都还没写进去的日志。
//
// 覆盖：吵醒、睡醒问候、晚安、午安（含耦合）、/mute 静默、自由动作生命周期、每日额度。
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
const HOUR = 3600000
/** 2026 年 10 月 day 日 hh:mm（本地时区）。 */
const at = (hh, mm = 0, day = 3) => new Date(2026, 9, day, hh, mm, 0, 0).getTime()

// 基线：模糊区间归零（让判定不靠哈希运气），主动行为全关，用例按需打开。
const QUIET = {
  sleepStart: '23:00', sleepJitter: 0,
  wakeStart: '07:00', wakeJitter: 0,
  greetEnabled: false, greetNoonEnabled: false,
  talkEnabled: false, actionEnabled: false,
  weatherEnabled: false,
}

console.log('\n1. 吵醒：睡着时在窗口内连发够条数 → 临时清醒')
await withKaren({
  startAt: at(23, 30),
  config: { ...QUIET, barrageCount: 3, barrageWindowMinutes: 3, barrageAwakeMinutes: 30 },
}, async (karen) => {
  check('起始处于 asleep', (await karen.snapshot()).phase === 'asleep', (await karen.snapshot()).phase)

  karen.userSays(2)
  let snap = await karen.snapshot()
  check('两条消息不足以吵醒（阈值 3）', snap.phase === 'asleep', snap.phase)
  check('stirCount 仍是 0', snap.stirCount === 0, String(snap.stirCount))

  karen.userSays(1)
  snap = await karen.snapshot()
  check('第 3 条触发吵醒 → awake', snap.phase === 'awake', snap.phase)
  check('stirCount 变成 1', snap.stirCount === 1, String(snap.stirCount))
  check('日志记了一条 stir', (await karen.logKinds()).includes('stir'), (await karen.logKinds()).join(','))

  karen.advance(31 * MIN)
  await karen.tickAndSettle()
  check('临时清醒 30 分钟后又睡回去', (await karen.snapshot()).phase === 'asleep', (await karen.snapshot()).phase)
})

console.log('\n2. 睡醒问候：只在新醒来的窗口内、每天一次')
await withKaren({ startAt: at(8, 0, 3), config: { ...QUIET, greetEnabled: true } }, async (karen) => {
  await karen.tickAndSettle()
  check('第一次 tick 不算睡醒（没有上一个醒来时刻）', karen.said().length === 0, karen.said().join(' | '))

  karen.advance(23 * HOUR + 30 * MIN) // 10/3 08:00 → 10/4 07:30
  await karen.tickAndSettle()
  check('跨过醒来时刻后问候一次', karen.said().length === 1, `${karen.said().length} 条`)
  check('日志记为 greet-wake', (await karen.logKinds()).includes('greet-wake'), (await karen.logKinds()).join(','))

  karen.clearSaid()
  await karen.tickAndSettle()
  check('同一天再 tick 不会重复问候', karen.said().length === 0, karen.said().join(' | '))
})

console.log('\n3. 晚安：睡前提前 N 分钟道别，每天一次')
await withKaren({
  startAt: at(22, 40, 3),
  config: { ...QUIET, greetEnabled: true, nightLeadMinutes: 10 },
}, async (karen) => {
  await karen.tickAndSettle()
  check('离睡前还有 20 分钟时不说话', karen.said().length === 0, karen.said().join(' | '))

  karen.advance(15 * MIN) // 22:40 → 22:55，进入提前 10 分钟的窗口
  await karen.tickAndSettle()
  check('进入睡前窗口后道晚安', karen.said().length === 1, `${karen.said().length} 条`)
  check('日志记为 greet-night', (await karen.logKinds()).includes('greet-night'), (await karen.logKinds()).join(','))

  karen.clearSaid()
  await karen.tickAndSettle()
  check('同一天不重复道晚安', karen.said().length === 0, karen.said().join(' | '))
})

console.log('\n4. 午安：中午窗口内问候一次')
await withKaren({
  startAt: at(11, 50, 3),
  config: {
    ...QUIET,
    greetEnabled: true, greetNoonEnabled: true,
    noonStart: '12:00', noonJitterMinutes: 0, greetWindowMinutes: 180,
  },
}, async (karen) => {
  await karen.tickAndSettle()
  check('11:50 还没到中午，不说话', karen.said().length === 0, karen.said().join(' | '))

  karen.advance(15 * MIN) // → 12:05
  await karen.tickAndSettle()
  check('12:05 道午安', karen.said().length === 1, `${karen.said().length} 条`)
  check('日志记为 greet-noon', (await karen.logKinds()).includes('greet-noon'), (await karen.logKinds()).join(','))

  karen.clearSaid()
  await karen.tickAndSettle()
  check('同一天不重复道午安', karen.said().length === 0, karen.said().join(' | '))
})

console.log('\n4b. 已知耦合：「午安」被「打招呼」总开关罩着')
await withKaren({
  startAt: at(11, 50, 3),
  config: {
    ...QUIET,
    greetEnabled: false, greetNoonEnabled: true,
    noonStart: '12:00', noonJitterMinutes: 0,
  },
}, async (karen) => {
  karen.advance(15 * MIN) // → 12:05，正午安窗口内
  await karen.tickAndSettle()
  check('关掉总开关后，单独开着「午安」也不生效（当前实现如此，面板上两个开关并不独立）',
    karen.said().length === 0, karen.said().join(' | '))
})

console.log('\n5. /mute：静默期内主动输出整段跳过，解除后照常')
await withKaren({
  startAt: at(22, 40, 3),
  config: { ...QUIET, greetEnabled: true, nightLeadMinutes: 10 },
}, async (karen) => {
  const mute = karen.commands.get('mute').handler
  const on = mute({ agent: karen.agent, rawInput: '2h' })
  check('/mute 2h 返回成功', on && on.kind === 'success', JSON.stringify(on))
  check('快照里 muted 为真', (await karen.snapshot()).muted === true)

  karen.advance(15 * MIN)
  await karen.tickAndSettle()
  check('静默期内不道晚安', karen.said().length === 0, karen.said().join(' | '))
  check('静默期内连 greet-night 日志都没有（是跳过，不是说了再吞）',
    !(await karen.logKinds()).includes('greet-night'), (await karen.logKinds()).join(','))

  const off = mute({ agent: karen.agent, rawInput: 'off' })
  check('/mute off 返回成功', off && off.kind === 'success', JSON.stringify(off))
  check('解除静默后 muted 为假', (await karen.snapshot()).muted === false)

  await karen.tickAndSettle()
  check('解除静默后在同一时刻补上晚安', karen.said().length === 1, `${karen.said().length} 条`)
})

console.log('\n6. 自由动作：karen_action 开始 → 到点结束并注入收尾')
await withKaren({ startAt: at(14, 0, 3), config: { ...QUIET } }, async (karen) => {
  const started = karen.tools.get('karen_action').execute({ label: '做饭', minutes: 30 }, { agent: karen.agent })
  check('工具返回标签与时长', started && started.label === '做饭' && started.minutes === 30, JSON.stringify(started))
  check('日志记为 action-start', (await karen.logKinds()).includes('action-start'), (await karen.logKinds()).join(','))
  check('动作未到点时不注入收尾', karen.said().length === 0, karen.said().join(' | '))

  karen.advance(31 * MIN)
  await karen.tickAndSettle()
  check('到点后注入收尾提示', karen.said().length === 1, `${karen.said().length} 条`)
  check('日志记为 action-done', (await karen.logKinds()).includes('action-done'), (await karen.logKinds()).join(','))
  check('动作已从状态里清空', (await karen.snapshot()).actionLabel === '',
    JSON.stringify((await karen.snapshot()).actionLabel))
})

console.log('\n7. 每日额度：动作达到 actionDailyMax 就不再开始')
await withKaren({
  startAt: at(9, 0, 3),
  config: {
    ...QUIET,
    actionEnabled: true, actionDailyMax: 2,
    actionIntervalMinutes: 5, actionJitterMinutes: 0, actionIdleMinutes: 1,
  },
}, async (karen) => {
  for (let i = 0; i < 12; i += 1) {
    karen.advance(6 * MIN)
    await karen.tickAndSettle()
  }
  const started = (await await karen.logKinds()).filter((kind) => kind === 'action').length
  check('一天最多开始 2 次动作', started === 2, `实际 ${started} 次`)
})

console.log('\n8. 磁盘形态：易失字段绝不能落盘（否则重启行为会跟着变）')
await withKaren({ startAt: at(14, 0, 3), config: { ...QUIET } }, async (karen) => {
  karen.tools.get('karen_action').execute({ label: '散步', minutes: 20 }, { agent: karen.agent })
  karen.userSays(1)
  await karen.tickAndSettle()

  const disk = karen.readDisk()
  check('磁盘顶层结构没变',
    ['config', 'state', 'log', 'refs', 'weather', 'locale'].every((key) => key in disk),
    Object.keys(disk).join(', '))

  const rec = disk.state && disk.state['sess-1']
  check('这个会话在磁盘上', !!rec && typeof rec === 'object', JSON.stringify(disk.state))

  const volatile = [
    'recent', 'phase', 'lastUserAt', 'nextActionAt', 'lastActionAt',
    'nextTalkAt', 'actionRollCount', 'talkRollCount',
  ]
  const leaked = volatile.filter((key) => Object.prototype.hasOwnProperty.call(rec || {}, key))
  check('八个易失字段一个都没落盘', leaked.length === 0, leaked.join(', '))

  check('持久字段照旧落盘（action）',
    Object.prototype.hasOwnProperty.call(rec || {}, 'action'), JSON.stringify(rec))
})

console.log('\n9. debug reset：持久与易失一起清掉（此前易失那一半会活下来）')
await withKaren({ startAt: at(14, 0, 3), config: { ...QUIET } }, async (karen) => {
  // 走 fireAction 那条路（act-now），它同时写易失的 lastActionAt 和持久的每日计数。
  await karen.request('POST', '/project-karen/debug', { action: 'act-now' })
  await karen.settle()
  const before = await karen.snapshot()
  check('act-now 之后 lastActionAt 有值（易失那一半）', !!before.lastActionAt, JSON.stringify(before.lastActionAt))
  check('act-now 之后 actionToday 记了 1（持久那一半）', before.actionToday === 1, String(before.actionToday))

  const res = await karen.request('POST', '/project-karen/debug', { action: 'reset' })
  check('debug reset 作用到 1 个会话', res.body && res.body.affected === 1, JSON.stringify(res.body))

  const after = await karen.snapshot()
  check('reset 之后 lastActionAt 被清掉（此前它留在内存里活了下来）',
    after.lastActionAt === null, JSON.stringify(after.lastActionAt))
  check('reset 之后每日计数也归零', after.actionToday === 0, String(after.actionToday))
})

console.log('\n10. 投递出去的消息必须过宿主的 V4 准入（这条差点漏掉）')
await withKaren({
  startAt: at(22, 40, 3),
  config: { ...QUIET, greetEnabled: true, nightLeadMinutes: 10 },
}, async (karen) => {
  karen.advance(15 * MIN)
  await karen.tickAndSettle()                                   // 道晚安 → 投递一条
  await karen.request('POST', '/project-karen/debug', { action: 'act-now' })  // 自由动作 → 再投一条
  await karen.settle()

  check('确实发生了投递（否则下面两条是空断言）', karen.delivered.length >= 2, String(karen.delivered.length))
  check('每条投递都通过 V4 准入检查', karen.problems.length === 0, JSON.stringify(karen.problems))
  check('source.kind 是 plugin:<插件名>，且不带废弃的 plugin 字段',
    karen.delivered.every((m) => m.source.kind === 'plugin:project-karen' && m.source.plugin === undefined),
    JSON.stringify(karen.delivered.map((m) => m.source)))
})

if (failures.length > 0) {
  console.log(`\n\u2717 ${failures.length} 项未通过（${pass} 项通过）\n`)
  process.exit(1)
}
console.log(`\n\u2713 全部通过（${pass} 项）\n`)
