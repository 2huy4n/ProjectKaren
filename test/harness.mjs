#!/usr/bin/env node
// 测试接缝：在进程内把 dsh/index.js 的 apply() 真的跑起来。
//
// 背景：dsh/index.js 此前是 0% 被执行。tick、问候、/mute、六个路由、两个工具的
// execute 体，全都关在 apply(ctx, config) 的闭包里，没有任何测试能进去。这个
// harness 用最小假 ctx 把那层闭包打开。
//
// 四件事让「不可能测」变成「确定性地测」：
//
//   1. 假 ctx —— 只提供 apply() 真正触碰到的成员。用不到的一律不实现，这样
//      接口一旦变宽，测试会当场炸掉而不是默默通过。
//   2. 假时钟 —— 接管 Date.now。配合 store 的 config.offsetMinutes，几小时的
//      模拟时间被压缩成一次函数调用。
//   3. 假定时器 —— 接管 setInterval。tick 的 20 秒心跳被收进注册表，由测试手动
//      点火；否则一次 tick 要真等 20 秒，调度相关的断言没法写。
//   4. 假事件总线 —— 记住 ctx.on / agent.ctx.on 注册的处理器，测试可以投递
//      session/event，从而触发「用户说了话」这条路径下的吵醒与问候。
//
// 产品代码一行都不改：靠的是在 import dsh/index.js 之前替换两个全局。
//
// 用法：
//   import { startKaren } from './harness.mjs'
//   const k = await startKaren({ config: { defaultMuted: false } })
//   k.advance(9 * 3600 * 1000); k.tick()
//   k.userSays()         // 模拟用户发一条消息
//   k.said()             // 观察「她说了什么」
//   await k.status()     // 观察面板看到的载荷
//   k.stop()
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

/** 必须与 dsh/index.js 的 TICK_MS 一致；对不上时 harness 会立刻报错，不会静默。 */
export const TICK_MS = 20000
const WEATHER_TIMER_MS = 10 * 60 * 1000

/**
 * 按 DSH 的会话格式 V4 校验一条要投出去的消息，返回问题清单（空 = 合规）。
 *
 * 判定依据取自宿主本体：
 *   @deepseek-ai/dsh-session-format-v3-to-v4 的 source() 准入 —— kind 必须是非空
 *   字符串，且**明确拒绝 'plugin'**（那是 V3 的退化写法，V4 要求 producer-owned）。
 * 消息必须带 identity（id / role / content），否则会被原样写进会话日志，留下一条
 * 恢复不了的记录（roleplaytimer 的注释记了这个坑）。
 */
export function validateMessage(message) {
  const problems = []
  if (!message || typeof message !== 'object') return ['消息不是对象']
  if (typeof message.id !== 'string' || message.id.length === 0) problems.push('id 必须是非空字符串')
  if (message.role !== 'user') problems.push('role 必须是 user')
  if (!Array.isArray(message.content)) problems.push('content 必须是数组')
  const kind = message.source && message.source.kind
  if (typeof kind !== 'string' || kind.length === 0) problems.push('source.kind 必须是非空字符串')
  else if (kind === 'plugin') problems.push("source.kind 不能是 'plugin'（V4 要求 producer-owned，应写成 plugin:<名字>）")
  else if (message.source.plugin !== undefined) problems.push('source.plugin 是 V3 的废弃字段，V4 里应去掉')
  return problems
}

// 假时钟与假定时器是进程级的全局。两个实例同时活着会互相覆盖 Date.now，
// 于是后启动的那个决定前面那个「现在几点」—— 症状是断言莫名其妙地空掉。
// 与其让它悄悄污染，不如在第二次启动时当场炸掉。
let live = null

export async function startKaren({ config = {}, sessionId = 'sess-1', lang = 'zh', startAt } = {}) {
  if (live) {
    throw new Error('harness: 已有实例在运行（假时钟是进程级的）。请先 stop() 上一个再启动。')
  }
  const realNow = Date.now
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval

  const dir = mkdtempSync(path.join(tmpdir(), 'karen-harness-'))
  process.env.DSH_HOME = dir
  const configFile = path.join(dir, 'project-karen.json')

  // ── 假时钟 ────────────────────────────────────────────────────────
  let clock = startAt ?? realNow()
  Date.now = () => clock

  // ── 假定时器 ──────────────────────────────────────────────────────
  const intervals = []
  let nextTimerId = 1
  globalThis.setInterval = (fn, ms) => {
    const handle = { id: nextTimerId++, fn, ms }
    intervals.push(handle)
    return handle
  }
  globalThis.clearInterval = (handle) => {
    const at = intervals.indexOf(handle)
    if (at >= 0) intervals.splice(at, 1)
  }

  const i18n = await load('dsh/i18n.mjs')
  i18n.setLang(lang)
  const mod = await load('dsh/index.js')

  // ── 观察点：测试只看这些，不碰内部实现 ────────────────────────────
  const delivered = []   // 插件投进会话的消息（= 角色说了什么）
  const problems = []    // 不合规的投递（宿主会拒绝的形状）
  const sections = new Map()  // 注入系统提示词的分节，按 name 索引
  const tools = new Map()
  const routes = []
  const commands = new Map()
  const warnings = []

  // ── 事件总线：ctx.on 与 agent.ctx.on 共用一个注册表 ────────────────
  // 两侧的名字不重叠（'agent/created' vs 'session/event'），所以一个表够用。
  const handlers = new Map()
  const on = (name, fn) => {
    const list = handlers.get(name) || []
    list.push(fn)
    handlers.set(name, list)
    return () => {
      const at = list.indexOf(fn)
      if (at >= 0) list.splice(at, 1)
    }
  }

  const agent = {
    id: sessionId,
    session: { id: sessionId },
    followup(message) {
      // 真实宿主会按会话格式校验 inbox；这里照着校验，否则「消息形状不合规」这类
      // 问题在测试里完全隐形 —— 正是它让 175 项断言全绿却漏掉了 V4 的 source 规则。
      problems.push(...validateMessage(message))
      delivered.push(message)
      return true
    },
    runMaintenance(fn) { return Promise.resolve(fn()) },
    ctx: {
      effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
      on,
      systemPrompt: {
        section(spec) { sections.set(spec.name, spec); return () => sections.delete(spec.name) },
      },
    },
  }

  const webServer = { register(spec) { routes.push(spec) } }
  const commandReg = { register(spec) { commands.set(spec.name, spec) } }

  const ctx = {
    logger: {
      info() {},
      warn(msg) { warnings.push(String(msg)) },
      error(msg) { warnings.push(String(msg)) },
    },
    get() { return undefined },
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    on,
    agents: { roots: () => [agent] },
    tools: { register(spec) { tools.set(spec.name, spec) } },
    inject(names, fn) {
      const scope = {}
      if (names.includes('webServer')) scope.webServer = webServer
      if (names.includes('commands')) scope.commands = commandReg
      fn(scope)
    },
    attachments: {
      async saveImages(images) {
        return images.map((image) => ({
          attachmentId: 'sha256:' + '0'.repeat(64),
          mediaType: image.mediaType,
          bytes: image.data.length,
          width: 1,
          height: 1,
        }))
      },
      async readImage() { throw new Error('harness: readImage 未实现') },
    },
  }

  await mod.apply(ctx, { defaultMuted: false, ...config })
  await Promise.resolve()

  // ── 路由调用 ──────────────────────────────────────────────────────
  async function request(method, urlPath, body) {
    const spec =
      routes.find((r) => r.kind === 'exact' && r.path === urlPath) ||
      routes.find((r) => r.kind === 'prefix' && urlPath.startsWith(r.path))
    if (!spec) throw new Error(`harness: 没有匹配的路由 ${urlPath}`)

    const req = {
      method,
      url: urlPath,
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
      },
    }
    let status = 0
    let headers = {}
    const chunks = []
    const res = {
      writeHead(code, head) { status = code; headers = head || {} },
      end(data) {
        if (data === undefined) return
        chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'))
      },
    }
    await spec.handler(req, res)
    const raw = Buffer.concat(chunks)
    let parsed
    try { parsed = JSON.parse(raw.toString('utf8')) } catch { parsed = undefined }
    return { status, headers, body: parsed, raw }
  }

  const harness = {
    dir,
    configFile,
    agent,
    ctx,
    delivered,
    problems,
    sections,
    tools,
    routes,
    commands,
    warnings,
    sessionId,

    now: () => clock,
    advance(ms) { clock += ms; return clock },

    /** 点火：把注册表里周期为 ms 的定时器各跑一次。 */
    fire(ms) {
      const hits = intervals.filter((handle) => handle.ms === ms)
      for (const handle of hits) handle.fn()
      return hits.length
    },
    /** 走一次 tick。周期对不上说明 index.js 的 TICK_MS 变了。 */
    tick() {
      const fired = harness.fire(TICK_MS)
      if (fired === 0) throw new Error(`harness: 没有注册周期为 ${TICK_MS}ms 的定时器（TICK_MS 变了？）`)
      return fired
    },
    runWeatherTimer() { return harness.fire(WEATHER_TIMER_MS) },
    intervalPeriods: () => intervals.map((handle) => handle.ms),

    /**
     * 把悬着的 Promise 链跑完。
     *
     * 必须知道：say() 的投递是同步的（followup 在 Promise.resolve(fn()) 里当场被调），
     * 但它的**日志写在 .then() 里**，要等一个微任务。所以 tick() 之后立刻读日志会
     * 读空。凡是要断言日志、或断言「没写日志」的地方，都先 await settle()。
     */
    async settle() { await new Promise((resolve) => setImmediate(resolve)) },

    /** tick 一次并把异步链路跑完。断言日志请用这个，别直接用 tick()。 */
    async tickAndSettle() { harness.tick(); await harness.settle() },

    /** 投递一个事件，返回实际被调用的处理器个数。 */
    emit(name, ...args) {
      const list = handlers.get(name) || []
      for (const fn of list) fn(...args)
      return list.length
    },
    /** 模拟「用户在这个会话里发了一条消息」。 */
    userSays(times = 1) {
      let count = 0
      for (let i = 0; i < times; i += 1) {
        count += harness.emit('session/event', agent.session, {
          type: 'user/message',
          data: { source: { kind: 'user' } },
        })
      }
      return count
    },

    request,
    async status() { return (await request('GET', '/project-karen/status')).body },
    /** 会话当前快照（status 载荷里这个会话的那一条）。 */
    async snapshot() {
      const body = await harness.status()
      return (body && body.agents && body.agents[0]) || null
    },

    /** 注入给模型的分节文本；name 见 index.js 的 'project-karen-*'。 */
    promptOf(name) {
      const spec = sections.get(name)
      return spec ? spec.text() : ''
    },
    /** 所有分节的 { name, text }，方便整体断言。 */
    prompts() {
      return [...sections.entries()].map(([name, spec]) => ({ name, text: spec.text() }))
    },

    readDisk() { return JSON.parse(readFileSync(configFile, 'utf8')) },
    diskLog() { return harness.readDisk().log || [] },
    /**
     * 插件当前的内存日志 —— 走 /status，也就是面板看到的那个。
     *
     * 不要改用 diskLog()：say() 的 pushLog 只写内存，自己不调 persist()，
     * 所以磁盘上的日志永远是滞后的，读它会得到假的「什么都没发生」。
     */
    async logKinds() {
      const body = await harness.status()
      return (body.log || []).map((entry) => entry.kind)
    },
    /** 投进会话的消息文本，按顺序。 */
    said() {
      return delivered.map((message) => (message.content || []).map((block) => block.text || '').join(''))
    },
    clearSaid() { delivered.length = 0 },

    stop() {
      for (const handle of [...intervals]) {
        try { globalThis.clearInterval(handle) } catch {}
      }
      intervals.length = 0
      Date.now = realNow
      globalThis.setInterval = realSetInterval
      globalThis.clearInterval = realClearInterval
      rmSync(dir, { recursive: true, force: true })
      delete process.env.DSH_HOME
      if (live === harness) live = null
    },
  }

  live = harness
  return harness
}
