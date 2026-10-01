#!/usr/bin/env node
// 默认值不得被语言「冻结」进配置。
//
// 背景：photoPrompt 的默认值是一句会随语言变化的文案。旧实现在 defaultConfig() 里
// 就用 t() 把它求值了，而 config 会落盘 —— 于是用户在中文界面下保存过一次之后，
// 那句中文就被永久写进 project-karen.json，之后切英文也永远不会更新。
//
// 固定住四条不变量：
//   1. defaultConfig() 与语言无关（往里放 t() 就会当场失败）
//   2. photoPrompt 的默认是空串；空值经 normalizeConfig 仍是空（不被物化）
//   3. 旧版本冻结进去的默认值，装载时被还原成空；用户自定义的值原样保留
//   4. 空值落盘再读回，磁盘上依然是空（不会把译文写进 JSON）
//
// 用法：npm test
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

const i18n = await load('dsh/i18n.mjs')
const { Store, normalizeConfig, defaultConfig } = await load('dsh/store.js')

let pass = 0
const failures = []
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \u2713 ${name}`) }
  else { failures.push(`${name}${extra ? '  →  ' + extra : ''}`); console.log(`  \u2717 ${name}${extra ? '  →  ' + extra : ''}`) }
}

console.log('\n1. defaultConfig() 必须与语言无关')
i18n.setLang('zh')
const zhDef = defaultConfig()
i18n.setLang('en')
const enDef = defaultConfig()
const diff = Object.keys(zhDef).filter((k) => JSON.stringify(zhDef[k]) !== JSON.stringify(enDef[k]))
check('zh 与 en 下 defaultConfig() 完全一致', diff.length === 0,
  diff.map((k) => `${k}: ${JSON.stringify(zhDef[k])} vs ${JSON.stringify(enDef[k])}`).join(', '))
check('photoPrompt 的默认是空串（空 = 运行时取默认）', zhDef.photoPrompt === '', JSON.stringify(zhDef.photoPrompt))

console.log('\n2. 空值不被物化')
i18n.setLang('zh')
check('normalizeConfig({}) 的 photoPrompt 是空', normalizeConfig({}).photoPrompt === '')
i18n.setLang('en')
check('切到英文后依然是空', normalizeConfig({}).photoPrompt === '')
check('显式传空串也是空', normalizeConfig({ photoPrompt: '' }).photoPrompt === '')
check('只有空白字符也当作空', normalizeConfig({ photoPrompt: '   ' }).photoPrompt === '')
check('用户自定义的值原样保留', normalizeConfig({ photoPrompt: '雨天的老街' }).photoPrompt === '雨天的老街')
check('自定义值仍然限长 800', normalizeConfig({ photoPrompt: 'x'.repeat(1000) }).photoPrompt.length === 800)

console.log('\n3. 旧版本冻结进去的默认值会被还原')
for (const lang of ['zh', 'en']) {
  const frozen = i18n.dicts[lang]['default.photoPrompt']
  check(`${lang} 的旧默认值被识别为「没设过」`, normalizeConfig({ photoPrompt: frozen }).photoPrompt === '',
    JSON.stringify(frozen))
}

console.log('\n4. 落盘再读回：磁盘上不能出现译文')
const dir = mkdtempSync(path.join(tmpdir(), 'karen-cfgdef-'))
process.env.DSH_HOME = dir
const file = path.join(dir, 'project-karen.json')
{
  i18n.setLang('zh')
  const s = new Store({ filePath: file })
  s.persist()
  const disk = JSON.parse(readFileSync(file, 'utf8')).config.photoPrompt
  check('中文界面下保存 → 磁盘上仍是空', disk === '', JSON.stringify(disk))

  // 模拟「已存在一份冻结了中文默认值的旧配置」
  const legacy = JSON.parse(readFileSync(file, 'utf8'))
  legacy.config.photoPrompt = i18n.dicts.zh['default.photoPrompt']
  const { writeFileSync } = await import('node:fs')
  writeFileSync(file, JSON.stringify(legacy), 'utf8')

  i18n.setLang('en')
  const s2 = new Store({ filePath: file })
  check('旧配置里的冻结值被还原成空（切英文后能拿到英文默认）', s2.config.photoPrompt === '', JSON.stringify(s2.config.photoPrompt))

  // 再存一次，确认不会把英文默认写回去
  s2.setConfig({ citySelf: 'Hangzhou' })
  const disk2 = JSON.parse(readFileSync(file, 'utf8')).config.photoPrompt
  check('再保存一次，磁盘上还是空（不会写回英文默认）', disk2 === '', JSON.stringify(disk2))

  // 用户自定义的值必须活下来
  s2.setConfig({ photoPrompt: '我的自定义提示词' })
  const disk3 = JSON.parse(readFileSync(file, 'utf8')).config.photoPrompt
  check('用户自定义的值正常落盘', disk3 === '我的自定义提示词', JSON.stringify(disk3))
}
rmSync(dir, { recursive: true, force: true })
delete process.env.DSH_HOME
i18n.setLang('zh')

if (failures.length > 0) {
  console.log(`\n\u2717 ${failures.length} 项未通过（${pass} 项通过）\n`)
  process.exit(1)
}
console.log(`\n\u2713 全部通过（${pass} 项）\n`)
