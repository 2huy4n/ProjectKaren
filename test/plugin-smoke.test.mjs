#!/usr/bin/env node
// 接缝冒烟测试：证明 apply() 可以在进程内被驱动。
//
// 这个文件不测业务逻辑，只测「那层闭包打开了」：启动、心跳、路由、注入分节、
// 假时钟真的能推动阶段切换，以及并发保护生效。它红了说明 harness 坏了；
// 它绿了，后面的特征测试才有意义。
//
// 注意：假时钟是进程级全局，所以每个实例必须 stop() 之后才能起下一个。
// harness 会在并发启动时直接报错，不要绕过它。
//
// 用法：npm test
import { startKaren, TICK_MS } from './harness.mjs'

// 必须在任何 harness 启动之前取，否则拿到的是打过补丁的那份。
const REAL_SET_INTERVAL = globalThis.setInterval

let pass = 0
const failures = []
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \u2713 ${name}`) }
  else { failures.push(`${name}${extra ? '  →  ' + extra : ''}`); console.log(`  \u2717 ${name}${extra ? '  →  ' + extra : ''}`) }
}

/** 起一个实例，跑完保证收摊。 */
async function withKaren(opts, fn) {
  const karen = await startKaren(opts)
  try { return await fn(karen) } finally { karen.stop() }
}

// 深夜 23:30，且把模糊区间归零 —— 让「睡着」这件事可判定，不靠哈希运气。
const NIGHT = new Date(2026, 9, 3, 23, 30, 0, 0).getTime()
const NOON = new Date(2026, 9, 3, 12, 0, 0, 0).getTime()
const FIXED = { sleepStart: '23:00', sleepJitter: 0, wakeStart: '07:00', wakeJitter: 0, greetNoonEnabled: false }

console.log('\n1. 启动：apply() 把该注册的都注册了')
const night = await startKaren({ startAt: NIGHT, config: FIXED })
check('六个路由注册齐（status/locale/config/debug/clear + prefix raw）', night.routes.length === 6, `实际 ${night.routes.length}`)
check('两个工具注册齐', night.tools.has('karen_photo') && night.tools.has('karen_action'),
  [...night.tools.keys()].join(', '))
check('/mute 命令注册了', night.commands.has('mute'))
check('四个系统提示词分节注册齐', night.sections.size === 4, [...night.sections.keys()].join(', '))
check('没有告警（注册过程干净）', night.warnings.length === 0, night.warnings.join(' | '))

console.log('\n2. 心跳：假定时器接管了 tick')
check('注册表里存在 20 秒周期', night.intervalPeriods().includes(TICK_MS), night.intervalPeriods().join(', '))
check('有 10 分钟周期的天气定时器', night.intervalPeriods().includes(10 * 60 * 1000))
check('tick() 点了 1 次火', night.tick() === 1)

console.log('\n3. 路由：/status 能调通并返回预期形状')
const status = await night.status()
check('/status 返回 ok', status && status.ok === true)
check('/status 带 agents 数组', Array.isArray(status && status.agents), JSON.stringify(status && status.agents))
check('会话 id 正确', status.agents[0] && status.agents[0].sessionId === 'sess-1', JSON.stringify(status.agents[0]))
check('深夜时 phase 是 asleep', status.agents[0] && status.agents[0].phase === 'asleep', status.agents[0] && status.agents[0].phase)
check('config 里的 apiKey 被脱敏或为空', status.config.apiKey === '' || /^\*{3}/.test(status.config.apiKey), JSON.stringify(status.config.apiKey))

console.log('\n4. 假时钟：同一份状态推到中午应该判为 awake')
night.advance(12 * 3600 * 1000) // 23:30 → 次日 11:30
night.tick() // /status 不自己刷新夜次，新鲜度由 tick 保证，所以先推一次
const noonStatus = await night.status()
check('推进 12 小时后 phase 变成 awake', noonStatus.agents[0] && noonStatus.agents[0].phase === 'awake', noonStatus.agents[0] && noonStatus.agents[0].phase)
check('跨天后 wakeAt 落到了新的一天', noonStatus.agents[0].wakeAt !== status.agents[0].wakeAt)

console.log('\n5. 收尾：stop() 把全局还回去了')
night.stop()
check('setInterval 已还原', globalThis.setInterval === REAL_SET_INTERVAL)
check('DSH_HOME 已清理', process.env.DSH_HOME === undefined)

console.log('\n6. 并发保护：第二个实例必须被拒绝')
const solo = await startKaren({ startAt: NIGHT, config: FIXED })
let refused = ''
try { await startKaren({ startAt: NOON, config: FIXED }) } catch (error) { refused = String(error && error.message) }
check('并发启动被拒绝（假时钟无法共存）', refused.length > 0, refused || '居然没报错')
solo.stop()

console.log('\n7. 注入分节：睡着与醒着注入的东西不一样')
await withKaren({ startAt: NIGHT, config: FIXED }, async (karen) => {
  check('深夜：睡眠分节有内容', karen.promptOf('project-karen-sleep').length > 0)
  check('深夜：动作分节为空', karen.promptOf('project-karen-action') === '',
    karen.promptOf('project-karen-action').slice(0, 60))
})
await withKaren({ startAt: NOON, config: FIXED }, async (karen) => {
  check('中午：睡眠分节为空', karen.promptOf('project-karen-sleep') === '',
    karen.promptOf('project-karen-sleep').slice(0, 60))
})
await withKaren({ startAt: NIGHT, config: { ...FIXED, enabled: false } }, async (karen) => {
  check('总开关关闭时全部注入为空', karen.prompts().every((p) => p.text === ''),
    karen.prompts().filter((p) => p.text !== '').map((p) => p.name).join(', '))
})

console.log('\n8. apiKey 掩码：各端点必须给出一致的形状，且掩码回传不能覆盖真 key')
await withKaren({ startAt: NOON, config: { apiKey: 'sk-abcdefgh1234' } }, async (karen) => {
  const status = await karen.status()
  const got = await karen.request('GET', '/project-karen/config')
  const saved = await karen.request('POST', '/project-karen/config', { config: { citySelf: '杭州' } })

  check('/status 把 key 掩成末四位', status.config.apiKey === '***1234', JSON.stringify(status.config.apiKey))
  check('/config GET 与 /status 掩码一致', got.body.value.apiKey === status.config.apiKey, JSON.stringify(got.body.value.apiKey))
  check('/config POST 回执与 /status 掩码一致', saved.body.value.apiKey === status.config.apiKey, JSON.stringify(saved.body.value.apiKey))

  // 用「不是当前 key 的掩码」去试探：守卫若失效，key 会被这串覆盖，掩码就会跟着变。
  // 用当前掩码本身试探是分不出来的 —— 覆盖前后长得一模一样。
  const probe = await karen.request('POST', '/project-karen/config', { config: { apiKey: '***ZZZZ' } })
  check('别的掩码回传不会覆盖真 key', probe.body.value.apiKey === '***1234', JSON.stringify(probe.body.value.apiKey))

  const blank = await karen.request('POST', '/project-karen/config', { config: { apiKey: '' } })
  check('空串表示不改，也不会把 key 清掉', blank.body.value.apiKey === '***1234', JSON.stringify(blank.body.value.apiKey))

  const fresh = await karen.request('POST', '/project-karen/config', { config: { apiKey: 'sk-newkey9999' } })
  check('新 key 能正常设进去', fresh.body.value.apiKey === '***9999', JSON.stringify(fresh.body.value.apiKey))
  check('换 key 之后 /status 立刻跟上', (await karen.status()).config.apiKey === '***9999')
})

console.log('\n9. 路由适配器：方法不对必须 405，且 allow 头要列全允许的方法')
await withKaren({ startAt: NOON, config: {} }, async (karen) => {
  // 期望值与 index.js 里那五条 jsonRoute 的声明一一对应
  const contract = [
    ['/project-karen/status', ['GET']],
    ['/project-karen/locale', ['POST']],
    ['/project-karen/config', ['GET', 'POST']],
    ['/project-karen/debug', ['POST']],
    ['/project-karen/clear', ['POST']],
  ]
  for (const [path, allowed] of contract) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const res = await karen.request(method, path, method === 'GET' ? undefined : {})
      if (allowed.includes(method)) {
        check(`${method} ${path} 不该被方法闸拦下`, res.status !== 405, `status=${res.status}`)
      } else {
        check(`${method} ${path} → 405 且 allow: ${allowed.join(', ')}`,
          res.status === 405 && res.headers.allow === allowed.join(', '),
          `status=${res.status} allow=${res.headers.allow}`)
      }
    }
  }
})

if (failures.length > 0) {
  console.log(`\n\u2717 ${failures.length} 项未通过（${pass} 项通过）\n`)
  process.exit(1)
}
console.log(`\n\u2713 全部通过（${pass} 项）\n`)
