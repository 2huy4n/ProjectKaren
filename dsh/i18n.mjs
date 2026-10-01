// ProjectKaren host 端零依赖双语模块。
//
// 唯一词典源：dsh/i18n/{zh,en}.json（面板文案在 client 侧内联，见 client/client.js）。
// 查找链：当前语言 → en 兜底 → key 原样返回（缺文案不空白）。
//
// 语言优先级：DSH 界面语言（由客户端上报，见 setLang）> 系统语言 > en。
// 宿主侧没有 locale 服务，所以「跟随 DSH 界面语言」必须由客户端把它解析出的
// 结果报上来；在客户端首次连接之前，用系统语言兜底。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const zh = JSON.parse(readFileSync(fileURLToPath(new URL('./i18n/zh.json', import.meta.url)), 'utf8'))
const en = JSON.parse(readFileSync(fileURLToPath(new URL('./i18n/en.json', import.meta.url)), 'utf8'))
const dicts = { zh, en }

/** DSH 宿主当前只提供这两种语言（见 @deepseek-ai/dsh-client-locale 的 LOCALE_IDS）。 */
export const SUPPORTED = ['zh', 'en']

/** 把任意 BCP 47 标记归一化成 'zh' | 'en'；识别不了返回 ''（交给兜底）。 */
export function normalizeLang(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase()
  if (raw.startsWith('zh')) return 'zh'
  if (raw.startsWith('en')) return 'en'
  return ''
}

/** 系统语言——客户端还没上报时的兜底。 */
export function systemLang() {
  try {
    const fromIntl = normalizeLang(Intl.DateTimeFormat().resolvedOptions().locale)
    if (fromIntl) return fromIntl
  } catch { /* 区域信息不可用时忽略 */ }
  const fromEnv = normalizeLang(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG)
  return fromEnv || 'en'
}

let current = systemLang()

/** 客户端上报 DSH 界面语言时调用；无法识别则保持不变。 */
export function setLang(value) {
  const next = normalizeLang(value)
  if (next) current = next
  return current
}

export function getLang() {
  return current
}

/**
 * 取一条文案。vars 形如 { city: '杭州' }，替换文案里的 {city} 占位符。
 * @param key 词典键
 * @param vars 占位符替换表
 * @param lang 强制语言（省略则用当前语言）
 */
export function t(key, vars, lang) {
  const want = normalizeLang(lang) || current
  const dict = dicts[want] || dicts.en
  let out = dict[key]
  if (out == null) out = en[key]
  if (out == null) out = key
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      out = out.split('{' + name + '}').join(String(value))
    }
  }
  return out
}

export { zh, en, dicts }
