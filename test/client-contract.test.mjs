#!/usr/bin/env node
// 面板契约测试：client/client.js 此前 0% 被执行 —— 全仓库最大的未测试面。
//
// 面板是浏览器 bundle，跑不了真的 React 渲染。但它有三条能测的缝：
//
//   1. 加载契约：window.__ModuleLoader__ 里那个 factory 能不能跑通、导出的东西
//      对不对。这条本身就有价值 —— client.js 里一个语法错误此前会静默上线。
//   2. apply(ctx) 的接线：词条注册、语言绑定与订阅、两个插槽、语言上报。
//   3. PhotoCard 的四条分支，含「meta 丢了就从正文里捞 sha256」的兜底路径。
//
// 再加两条主客端一致性，都不是读代码猜的：
//
//   4. Panel：用极小的 hook 桩把组件当普通函数调起来，喂给它一份**宿主真实
//      产出的 /status 载荷**。然后把它渲染出的所有 onClick 按一遍，看面板到底
//      往哪个路径发了什么 —— 这是行为观察，不是源码正则。
//   5. 面板发出去的每个调试动词，宿主都认得。判定方式是行为探针：宿主对未知
//      动作走 `return affected`，对已知动作走 `affected += 1`，所以一个活着的
//      会话下 affected === 1 就等于「这个动词被认了」。
//
// 用法：npm test
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { startKaren } from './harness.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC = readFileSync(path.join(ROOT, 'client/client.js'), 'utf8')

let pass = 0
const failures = []
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \u2713 ${name}`) }
  else { failures.push(`${name}${extra ? '  →  ' + extra : ''}`); console.log(`  \u2717 ${name}${extra ? '  →  ' + extra : ''}`) }
}

// ── 源码抽取：找 name(...) 的实参原文（括号配平，跳过字符串） ──────────
function argTexts(src, name) {
  const out = []
  for (const m of src.matchAll(new RegExp(`\\b${name}\\(`, 'g'))) {
    let i = m.index + m[0].length
    let depth = 1
    let inStr = null
    let esc = false
    for (; i < src.length; i += 1) {
      const c = src[i]
      if (esc) { esc = false; continue }
      if (c === '\\') { esc = true; continue }
      if (inStr) { if (c === inStr) inStr = null; continue }
      if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
      if (c === '(') depth += 1
      else if (c === ')') { depth -= 1; if (depth === 0) break }
    }
    out.push(src.slice(m.index + m[0].length, i).trim())
  }
  return out
}
const stringsIn = (text) => [...text.matchAll(/["']([^"']+)["']/g)].map((m) => m[1])
const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children || []).map(textOf).join('')
}
const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const kid of node) walk(kid, visit); return }
  visit(node)
  for (const kid of node.children || []) walk(kid, visit)
}

// ── 把 bundle 在 Node 里跑起来 ────────────────────────────────────────
let spec = null
const fakeWindow = { __ModuleLoader__: { load: (loaded) => { spec = loaded; return undefined } } }

// 极小的 hook 桩：把组件当普通函数调用。state 按调用序号注入。
let stateIndex = 0
let stateOverrides = []
const effects = []
const react = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState(initial) {
    const i = stateIndex
    stateIndex += 1
    const override = stateOverrides[i]
    return [override !== undefined ? override : (typeof initial === 'function' ? initial() : initial), () => {}]
  },
  useEffect(fn) { const cleanup = fn(); effects.push(cleanup); return cleanup },
  useCallback(fn) { return fn },
}
const resetHooks = (overrides = []) => { stateIndex = 0; stateOverrides = overrides }
const requireStub = (id) => {
  if (id === 'react') return react
  throw new Error(`client 请求了未预期的模块: ${id}`)
}

console.log('\n1. 加载契约：bundle 能跑通，导出的东西对')
let exported = null
let loadError = ''
try {
  new Function('window', 'require', SRC)(fakeWindow, requireStub)
  exported = spec && typeof spec.factory === 'function' ? spec.factory(requireStub) : null
} catch (error) {
  loadError = String(error && error.message)
}
check('factory 执行不抛错', loadError === '', loadError)
check('load 时的 id 是 project-karen', spec && spec.id === 'project-karen', JSON.stringify(spec && spec.id))
check('导出 name / inject / apply', !!(exported && exported.name && exported.inject && typeof exported.apply === 'function'),
  JSON.stringify(exported && Object.keys(exported)))
check('inject 声明了 locale 与 slots',
  Array.isArray(exported && exported.inject) && exported.inject.includes('locale') && exported.inject.includes('slots'),
  JSON.stringify(exported && exported.inject))

// ── 假 ctx：只提供 apply 真正会碰的东西 ──────────────────────────────
const slots = []
const fetches = []
let localeNS = null
let localeDicts = null
let subscribed = 0

const makeT = (dicts) => (key, vars) => {
  const raw = (dicts && (dicts.zh[key] !== undefined ? dicts.zh[key] : dicts.en[key])) ?? key
  if (!vars || typeof raw !== 'string') return raw
  return raw.replace(/\{(\w+)\}/g, (all, name) => (name in vars ? String(vars[name]) : all))
}

const ctx = {
  slots: {
    inject(_name, run) { run() },
    register(regSpec, component) { slots.push({ spec: regSpec, component }) },
  },
  locale: {
    register(ns, dicts) { localeNS = ns; localeDicts = dicts },
    bind() { return makeT(localeDicts || {}) },
    getSnapshot() { return { active: 'zh' } },
    subscribe(cb) { subscribed += 1; cb() },
  },
}

const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  fetches.push({ url, init })
  return { ok: true, status: 200, json: async () => ({ ok: true }) }
}

let applyError = ''
try { exported.apply(ctx) } catch (error) { applyError = String(error && error.message) }

console.log('\n2. apply 接线')
check('apply 不抛错', applyError === '', applyError)
check('注册了 project-karen 词条命名空间', localeNS === 'project-karen', String(localeNS))
check('词条同时提供 zh 与 en', !!(localeDicts && localeDicts.zh && localeDicts.en),
  JSON.stringify(localeDicts && Object.keys(localeDicts)))
check('订阅了语言变化（换语言要重报给宿主）', subscribed > 0, String(subscribed))

const byName = (name) => slots.find((s) => s.spec && s.spec.name === name)
const section = byName('settings.section')
const toolview = byName('tool.call.toolview')
check('挂了设置面板插槽 settings.section', !!section, slots.map((s) => s.spec && s.spec.name).join(', '))
check('挂了照片卡片插槽 tool.call.toolview', !!toolview, slots.map((s) => s.spec && s.spec.name).join(', '))
check('设置面板的 id / order / locale 正确',
  !!section && section.spec.id === 'project-karen' && section.spec.order === 57 && section.spec.locale === 'project-karen',
  JSON.stringify(section && section.spec))
check('两个插槽都给了 React 组件', slots.every((s) => typeof s.component === 'function'))
check('照片卡片绑定的是 karen_photo 工具', !!toolview && toolview.spec.key === 'karen_photo',
  JSON.stringify(toolview && toolview.spec))

const langCall = fetches.find((f) => String(f.url).endsWith('/locale'))
check('把界面语言上报给宿主（宿主没有 locale 服务）', !!langCall,
  fetches.map((f) => f.url).join(', '))
check('上报用的是 POST', !!langCall && langCall.init && langCall.init.method === 'POST',
  JSON.stringify(langCall && langCall.init && langCall.init.method))
check('上报的 body 里带了 lang',
  !!langCall && (() => { try { return !!JSON.parse(langCall.init.body).lang } catch { return false } })(),
  langCall && langCall.init && langCall.init.body)

console.log('\n3. PhotoCard：四条分支（含 sha256 兜底）')
const PhotoCard = toolview && toolview.component
const imgIn = (node) => {
  let found = null
  walk(node, (n) => { if (!found && n.type === 'img') found = n })
  return found
}
check('非对象输入返回 null', PhotoCard({ block: null }) === null)

const taking = textOf(PhotoCard({ block: {} }))
check('还没有 kind 时显示占位文案（且不是原始 key）', taking.length > 0 && taking !== 'photoCard.taking', taking)

const failedText = textOf(PhotoCard({ block: { kind: 'x', isError: true, content: [{ type: 'text', text: '超时' }] } }))
check('isError 时把正文的错因显示出来', failedText.includes('超时'), failedText)

const noMetaTree = PhotoCard({ block: { kind: 'x', content: [{ type: 'text', text: '普通文字' }] } })
check('拿不到 id 时显示「没有元数据」而不是一张碎图', !imgIn(noMetaTree), textOf(noMetaTree))

const metaImg = imgIn(PhotoCard({ block: { kind: 'x', meta: { attachmentId: 'sha256:abc' } } }))
check('有 meta.attachmentId 时渲染 img', !!metaImg)
check('img 指向宿主的 /raw 路由并做了编码',
  !!metaImg && String(metaImg.props.src).endsWith('/project-karen/raw/sha256%3Aabc'),
  metaImg && String(metaImg.props.src))

const sha = 'sha256:' + 'a'.repeat(64)
const fallbackImg = imgIn(PhotoCard({ block: { kind: 'x', content: [{ type: 'text', text: `图片 ${sha} 已保存` }] } }))
check('meta 丢了时能从正文里捞 sha256（兜底路径）', !!fallbackImg)
check('兜底捞出的 id 正确',
  !!fallbackImg && String(fallbackImg.props.src).endsWith('/project-karen/raw/' + encodeURIComponent(sha)),
  fallbackImg && String(fallbackImg.props.src))

// ── 起一个真宿主，拿它真实的 /status 载荷去喂面板 ────────────────────
const karen = await startKaren({ startAt: new Date(2026, 9, 3, 12, 0, 0, 0).getTime() })
const realStatus = await karen.status()

console.log('\n4. Panel：用宿主真实的 /status 载荷渲染，并把按钮按一遍')
const Panel = section.component().type
check('拿到 Panel 组件', typeof Panel === 'function')

resetHooks([null, null])
const loadingTree = textOf(Panel())
check('cfg 还没到时不炸，渲染加载态', loadingTree.length > 0, loadingTree)

const before = fetches.length
resetHooks([realStatus.config, realStatus])
let panelError = ''
let panelTree = null
try { panelTree = Panel() } catch (error) { panelError = String(error && error.message) }
check('拿到真实载荷后渲染不抛错', panelError === '', panelError)
check('渲染出了配置文件路径（说明配置那一支真的走了，不是空壳）',
  !!panelTree && textOf(panelTree).includes(realStatus.path),
  panelTree ? textOf(panelTree).slice(0, 120) : String(panelTree))

// 把渲染出来的每个 onClick 都按一遍 —— 看面板到底往哪发了什么
const clicks = []
walk(panelTree, (node) => { if (node.props && typeof node.props.onClick === 'function') clicks.push(node.props.onClick) })
check('面板渲染出了可点的按钮', clicks.length >= 8, `${clicks.length} 个`)

const posted = []
globalThis.fetch = async (url, init) => {
  fetches.push({ url, init })
  posted.push({ url: String(url), body: init && init.body ? (() => { try { return JSON.parse(init.body) } catch { return null } })() : null })
  return { ok: true, status: 200, json: async () => ({ ok: true, affected: 1, value: {}, removed: 0 }) }
}
for (const onClick of clicks) { try { onClick() } catch { /* 按钮自己会 guard，这里不该抛 */ } }
await new Promise((resolve) => setImmediate(resolve))

const pathsHit = new Set(posted.map((p) => p.url))
check('按按钮确实发出了请求', pathsHit.size > 0, [...pathsHit].join(', '))
const debugActions = posted.filter((p) => p.url.endsWith('/debug') && p.body && p.body.action).map((p) => p.body.action)
check('按钮里含调试动词请求', debugActions.length > 0, debugActions.join(', '))
check('每个调试请求都带上了 action',
  posted.filter((p) => p.url.endsWith('/debug')).every((p) => p.body && p.body.action),
  JSON.stringify(posted.filter((p) => p.url.endsWith('/debug')).map((p) => p.body)))
fetches.length = before

console.log('\n5. 主客端一致性：路径与动词，面板发的宿主都认')
const API = (SRC.match(/const API = "([^"]+)"/) || [])[1]
check('从源码里取到了 API 前缀', !!API, String(API))

const clientPaths = new Set()
for (const args of argTexts(SRC, 'call')) {
  const first = stringsIn(args)[0]
  if (first && first.startsWith('/')) clientPaths.add(first)
}
for (const m of SRC.matchAll(/API\s*\+\s*"([^"]+)"/g)) clientPaths.add(m[1])
check('抽取到了若干面板路径', clientPaths.size >= 4, [...clientPaths].join(', '))
check('宿主注册了路由', karen.routes.length > 0, String(karen.routes.length))

for (const p of clientPaths) {
  const full = API + p
  // 前缀路由必须带 / 边界再比：否则 "/project-karen2/status" 会被
  // startsWith("/project-karen") 放过去 —— 这个洞是变异测试照出来的。
  const hit = karen.routes.some((r) => (r.kind === 'exact' ? r.path === full : full.startsWith(r.path + '/')))
  check(`宿主有对应路由 ${full}`, hit, karen.routes.map((r) => `${r.kind}:${r.path}`).join(', '))
}

// 工具键也是主客端各写一遍：宿主注册时用 'karen_photo'，面板拿 PHOTO_TOOL 去认。
// 这个重复是结构性的 —— 面板要在 apply 阶段（还没 fetch 过任何东西）就知道它，
// 所以没法从宿主换取。既然消不掉，就用断言钉住。
const PHOTO_TOOL = (SRC.match(/const PHOTO_TOOL = "([^"]+)"/) || [])[1]
check('从源码里取到了照片工具键', !!PHOTO_TOOL, String(PHOTO_TOOL))
check(`宿主注册了同名工具 ${PHOTO_TOOL}`,
  !!PHOTO_TOOL && karen.tools.has(PHOTO_TOOL), [...karen.tools.keys()].join(', '))
check('照片卡片插槽绑的 key 与宿主工具同名',
  !!toolview && toolview.spec.key === PHOTO_TOOL, JSON.stringify(toolview && toolview.spec.key))

const verbs = new Set(debugActions)
for (const args of argTexts(SRC, 'debug')) for (const s of stringsIn(args)) verbs.add(s)
for (const args of argTexts(SRC, 'call')) {
  const strs = stringsIn(args)
  if (strs[0] === '/debug' && strs[1]) verbs.add(strs[1])
}
check('汇集到了若干调试动词（静态抽取 + 实际按钮）', verbs.size >= 6, [...verbs].sort().join(', '))

for (const verb of [...verbs].sort()) {
  // end-action 需要先有个动作在手，否则宿主会 continue 掉，affected 就是 0
  if (verb === 'end-action') {
    karen.tools.get('karen_action').execute({ label: '散步', minutes: 30 }, { agent: karen.agent })
  }
  const res = await karen.request('POST', '/project-karen/debug', { action: verb })
  check(`宿主认得动词 ${verb}`, res.body && res.body.affected === 1, JSON.stringify(res.body))
}
karen.stop()
globalThis.fetch = realFetch

if (failures.length > 0) {
  console.log(`\n\u2717 ${failures.length} 项未通过（${pass} 项通过）\n`)
  process.exit(1)
}
console.log(`\n\u2713 全部通过（${pass} 项）\n`)
