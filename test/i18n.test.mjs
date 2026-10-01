#!/usr/bin/env node
// 文案完整性校验 —— 防止「漏译静默降级」。
//
// 背景：t(key) 的设计是「查不到就原样返回 key」，好处是页面不崩、不空白，
// 代价是漏译时**静默降级**——界面上会直接出现 `prompt.foo` 这种字面量。
// 面板上顶多显示个 key，宿主侧更糟：会把 `prompt.xxx` 原文喂给模型。
// 这个脚本就是为了在加功能时把这类回归当场拦住。
//
// 校验四件事：
//   1. 两份词典（宿主 dsh/i18n/{zh,en}.json、客户端 client/client.js 内联）各自 zh/en 键集合互差
//   2. 占位符集合一致（zh 有 {a} 而 en 没有 → 英文渲染会漏参数）
//   3. 代码里所有 `t('...')` 字面量的键都真实存在
//   4. 动态拼接的键族（'weather.' + code 之类）走**白名单 + 逐项显式断言**
//
// 用法：npm test   （无依赖，纯 node）
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const rel = (p) => path.join(ROOT, p)

let pass = 0
const failures = []
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \u2713 ${name}`) }
  else { failures.push(`${name}${extra ? '  →  ' + extra : ''}`); console.log(`  \u2717 ${name}${extra ? '  →  ' + extra : ''}`) }
}

// ── 读词典 ────────────────────────────────────────────────────────
const zhHost = JSON.parse(readFileSync(rel('dsh/i18n/zh.json'), 'utf8'))
const enHost = JSON.parse(readFileSync(rel('dsh/i18n/en.json'), 'utf8'))
const clientSrc = readFileSync(rel('client/client.js'), 'utf8')

/** 抠出 `const NAME = { ... };` 的对象字面量并按值求值（括号配平，不用惰性正则）。 */
function extractObject(src, name) {
  const at = src.indexOf(`const ${name} = {`)
  if (at < 0) return null
  const open = src.indexOf('{', at)
  let depth = 0, inStr = null, esc = false
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (esc) { esc = false; continue }
    if (c === '\\') { esc = true; continue }
    if (inStr) { if (c === inStr) inStr = null; continue }
    if (c === '"' || c === "'") { inStr = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open, i + 1) }
  }
  return null
}
const zhClientText = extractObject(clientSrc, 'zh')
const enClientText = extractObject(clientSrc, 'en')
if (!zhClientText || !enClientText) {
  console.log('  \u2717 无法从 client/client.js 里抠出面板字典（zh / en）')
  process.exit(1)
}
const zhClient = new Function(`return (${zhClientText})`)()
const enClient = new Function(`return (${enClientText})`)()

const keys = (dict) => Object.keys(dict).filter((k) => !k.startsWith('_'))
const placeholderSet = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort().join(',')

/** 通用一致性检查：键集合互差 + 空值 + 占位符一致。 */
function checkPair(label, zh, en) {
  const kz = keys(zh), ke = keys(en)
  const onlyZh = kz.filter((k) => !(k in en))
  const onlyEn = ke.filter((k) => !(k in zh))
  check(`${label}：zh/en 键数一致`, kz.length === ke.length, `zh=${kz.length} en=${ke.length}`)
  check(`${label}：没有只有中文的键`, onlyZh.length === 0, onlyZh.join(', '))
  check(`${label}：没有只有英文的键`, onlyEn.length === 0, onlyEn.join(', '))
  const empty = [...kz, ...ke].filter((k) => String(zh[k] ?? en[k] ?? '').trim() === '')
  check(`${label}：没有空文案`, empty.length === 0, empty.join(', '))
  const mismatch = kz.filter((k) => k in en && placeholderSet(zh[k]) !== placeholderSet(en[k]))
  check(`${label}：zh/en 占位符集合一致`, mismatch.length === 0,
    mismatch.map((k) => `${k}(${placeholderSet(zh[k])} vs ${placeholderSet(en[k])})`).join(', '))
}

/** 扫一个文件里所有 t(...) 调用中出现的字面量键（排除三元比较值 / || 兜底 / 拼接前缀）。 */
function usedKeysIn(src) {
  const out = new Set()
  for (const m of src.matchAll(/\bt\(/g)) {
    let i = m.index + m[0].length, depth = 1, inStr = null, esc = false
    for (; i < src.length; i++) {
      const c = src[i]
      if (esc) { esc = false; continue }
      if (c === '\\') { esc = true; continue }
      if (inStr) { if (c === inStr) inStr = null; continue }
      if (c === '"' || c === "'") { inStr = c; continue }
      if (c === '(') depth++
      else if (c === ')') { depth--; if (depth === 0) break }
    }
    const inner = src.slice(m.index, i + 1)
    for (const s of inner.matchAll(/["']([a-z][A-Za-z0-9.]*)["']/g)) {
      const key = s[1]
      const before = inner.slice(0, s.index).replace(/\s+$/, '')
      if (key.endsWith('.')) continue                   // 拼接前缀，如 'weather.' + k
      if (/(\|\||==|!=|\+)$/.test(before)) continue     // 比较值 / 兜底值 / 拼接
      out.add(key)
    }
  }
  return out
}

// ── 动态拼接的键族：白名单 + 逐项显式断言 ───────────────────────────
// 这些键在代码里是拼出来的，静态扫描看不到，所以必须在这里点名核对。
const DYNAMIC_FAMILIES = [
  {
    prefix: 'weather.',
    where: 'dsh/index.js 的 t(\'weather.\' + weatherKey(code))',
    members: ['clear', 'partly', 'overcast', 'fog', 'drizzle', 'rain', 'snow', 'showers', 'snowShowers', 'thunder', 'unknown'],
  },
  {
    prefix: 'holiday.',
    where: 'dsh/index.js 的 t(\'holiday.\' + id + \'.name\' / \'.hint\')',
    members: [
      'newYear', 'valentine', 'womensDay', 'aprilFools', 'laborDay', 'childrensDay', 'teachersDay',
      'nationalDay', 'halloween', 'christmasEve', 'christmas', 'newYearEve',
      'springFestival', 'lantern', 'dragonBoat', 'qixi', 'midAutumn', 'doubleNinth',
    ].flatMap((id) => [`${id}.name`, `${id}.hint`]),
  },
  {
    prefix: 'prompt.birthday.',
    where: 'dsh/index.js 的 t(\'prompt.birthday.\' + kind)',
    members: ['self', 'user', 'both'],
  },
  {
    prefix: 'date.birthday.',
    where: 'client/client.js 的 t(\'date.birthday.\' + today.birthday)',
    members: ['self', 'user', 'both'],
  },
]
const DYNAMIC_PREFIXES = [...new Set(DYNAMIC_FAMILIES.map((f) => f.prefix))]

// ── 跑 ────────────────────────────────────────────────────────────
console.log('\n词典一致性')
checkPair('宿主词典 dsh/i18n', zhHost, enHost)
checkPair('面板词典 client/client.js', zhClient, enClient)

console.log('\n动态拼接键族（白名单）')
for (const fam of DYNAMIC_FAMILIES) {
  const inHost = fam.prefix.startsWith('date.') ? zhClient : zhHost
  const inHostEn = fam.prefix.startsWith('date.') ? enClient : enHost
  const missing = fam.members.filter((m) => !(`${fam.prefix}${m}` in inHost) || !(`${fam.prefix}${m}` in inHostEn))
  check(`${fam.prefix}* 共 ${fam.members.length} 个键都有中英（${fam.where}）`, missing.length === 0, missing.join(', '))
}

console.log('\n代码里引用的键是否都存在')
const hostFiles = ['dsh/index.js', 'dsh/store.js']
const hostUsed = new Map()
for (const f of hostFiles) {
  for (const k of usedKeysIn(readFileSync(rel(f), 'utf8'))) hostUsed.set(k, f)
}
const clientUsed = usedKeysIn(clientSrc)

const hostMissing = [...hostUsed.keys()].filter((k) => !(k in zhHost) || !(k in enHost))
check(`宿主 ${hostFiles.length} 个文件里的 t('...') 键都存在`, hostMissing.length === 0,
  hostMissing.map((k) => `${k}@@${hostUsed.get(k)}`).join(', '))
const clientMissing = [...clientUsed].filter((k) => !(k in zhClient) || !(k in enClient))
check('面板里的 t("...") 键都存在', clientMissing.length === 0, clientMissing.join(', '))
check('采样量合理（宿主 ≥ 30 个键）', hostUsed.size >= 30, `实际 ${hostUsed.size}`)
check('采样量合理（面板 ≥ 30 个键）', clientUsed.size >= 30, `实际 ${clientUsed.size}`)

console.log('\n反向：定义了却没被引用的键（可能忘了接线）')
const hostUnused = keys(zhHost).filter((k) => !hostUsed.has(k) && !DYNAMIC_PREFIXES.some((p) => k.startsWith(p)))
const clientUnused = keys(zhClient).filter((k) => !clientUsed.has(k) && !DYNAMIC_PREFIXES.some((p) => k.startsWith(p)))
check('宿主词典没有未接线的键', hostUnused.length === 0, hostUnused.join(', '))
check('面板词典没有未接线的键', clientUnused.length === 0, clientUnused.join(', '))

// ── 汇总 ──────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.log(`\n\u2717 ${failures.length} 项未通过（${pass} 项通过）\n`)
  process.exit(1)
}
console.log(`\n\u2713 全部通过（${pass} 项）\n`)
