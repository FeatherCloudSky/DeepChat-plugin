/**
 * 一致性检查（跨文件漂移）。
 *
 * offline-check.mjs 测的是「行为对不对」，这个脚本测的是
 * 「几份清单互相对不对得上」—— 这类漂移普通单测照不到：
 *   代码里读的配置键 / 锅巴面板暴露的字段 / cfg_default.json 的键 / 模板用的变量
 *
 * 做法：逐个 import 每个模块（同时完成语法检查 + 顶层执行），
 * 然后交叉比对几份清单。
 *
 * 用法：node test/consistency-check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let problems = 0
const fail = (msg) => { problems++; console.log('  \u2605 ' + msg) }
const ok = (msg) => console.log('  \u2713 ' + msg)
const rel = (f) => path.relative(pluginDir, f)

// Yunzai 注入的全局量，import 之前必须先准备好
globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {}, red: (s) => s }
globalThis.plugin = class { constructor(c) { Object.assign(this, c) } reply() { return Promise.resolve({}) } }
globalThis.redis = { get: async () => null, set: async () => 'OK', del: async () => 1, keys: async () => [] }

function collect(dir, test) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name)
    if (e.isDirectory()) { if (!/node_modules|\.git/.test(e.name)) out.push(...collect(f, test)) }
    else if (test(e.name)) out.push(f)
  }
  return out
}

const moduleFiles = collect(pluginDir, (n) => n.endsWith('.js'))

// ---------- 1. 逐个 import（语法 + 顶层执行）----------
console.log('\n【1】逐个 import 全部模块')
const importErrors = []
for (const f of moduleFiles) {
  try {
    await import(pathToFileURL(f).href)
  } catch (e) {
    importErrors.push(rel(f) + ' -> ' + (e.message || e))
  }
}
if (importErrors.length) importErrors.forEach(fail)
else ok(`${moduleFiles.length} 个模块全部 import 成功`)

// ---------- 2. 配置文件 ----------
console.log('\n【2】cfg_default.json')
let defaults = {}
try {
  const raw = fs.readFileSync(path.join(pluginDir, 'data', 'cfg_default.json'), 'utf8')
  const keys = [...raw.matchAll(/^\s*"([^"]+)"\s*:/gm)].map((m) => m[1])
  const dupes = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))]
  if (dupes.length) fail('存在重复键：' + dupes.join(', '))
  else ok(`JSON 合法，${keys.length} 个键，无重复`)
  defaults = JSON.parse(raw)
} catch (e) {
  fail('解析失败：' + e.message)
}

// ---------- 3. 代码里读的键 ----------
console.log('\n【3】代码里 Cfg.get* 读的键是否都有默认值')
const usedKeys = new Set()
for (const f of moduleFiles) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/Cfg\.get(?:Bool|Number|IdList)?\(\s*'([^']+)'/g)) {
    usedKeys.add(m[1])
  }
}
const missingKeys = [...usedKeys].filter((k) => !(k in defaults))
if (missingKeys.length) fail('用了但没有默认值的键：' + missingKeys.join(', '))
else ok(`${usedKeys.size} 个键全部有默认值`)

// ---------- 4. 锅巴面板字段 ----------
console.log('\n【4】锅巴面板暴露的字段是否都有默认值')
const guobaSrc = fs.readFileSync(path.join(pluginDir, 'guoba.support.js'), 'utf8')
const guobaFields = [...guobaSrc.matchAll(/field:\s*'([^']+)'/g)].map((m) => m[1])

// GSubForm 的 schemas 里的字段是「列表的一行」，不是顶层配置键，排除掉
const SUBFORM_FIELDS = new Set(['key', 'vision'])
const topFields = guobaFields.filter((f) => !SUBFORM_FIELDS.has(f))

const guobaMissing = topFields.filter((f) => !(f in defaults))
if (guobaMissing.length) fail('面板里有但默认配置里没有：' + guobaMissing.join(', '))
else ok(`${topFields.length} 个顶层字段全部有默认值（另有 ${guobaFields.length - topFields.length} 个 GSubForm 行内字段，已排除）`)

const dupFields = [...new Set(topFields.filter((f, i) => topFields.indexOf(f) !== i))]
if (dupFields.length) fail('面板字段重复：' + dupFields.join(', '))
else ok('面板字段无重复')

const tabs = [...guobaSrc.matchAll(/label:\s*'([^']+)',\s*component:\s*'SOFT_GROUP_BEGIN'/g)].map((m) => m[1])
ok(`面板标签页 ${tabs.length} 个：` + tabs.join(' / '))

// ---------- 5. 模板变量 ----------
console.log('\n【5】帮助模板的变量是否都由 buildRenderData 提供')
const tpl = fs.readFileSync(path.join(pluginDir, 'resources', 'help', 'index.html'), 'utf8')

const tplVars = new Set()
for (const m of tpl.matchAll(/\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g)) tplVars.add(m[1].split('.')[0])

// art-template 的指令关键字 + each 声明的循环变量，都不是数据字段
const builtin = new Set(['if', 'else', 'each', 'index'])
for (const m of tpl.matchAll(/\{\{each\s+\S+\s+(\w+)(?:\s+(\w+))?\s*\}\}/g)) {
  builtin.add(m[1])
  if (m[2]) builtin.add(m[2])
}

const { help } = await import(pathToFileURL(path.join(pluginDir, 'apps/help.js')).href)
const data = new help().buildRenderData({ title: 't', groups: [] })

const unknownVars = [...tplVars].filter((v) => !builtin.has(v) && !(v in data))
if (unknownVars.length) fail('模板用了但渲染数据没提供：' + unknownVars.join(', '))
else ok(`${tplVars.size} 个模板变量全部有值（其中 ${builtin.size} 个是模板本地变量，已排除）`)

// 用真的 art-template 渲染一遍（拿不到引擎就跳过，不影响其它检查）
try {
  const require_ = createRequire(path.join(pluginDir, 'package.json'))
  let template = require_('art-template')
  if (template?.default) template = template.default
  const rendered = template.render(tpl, data)
  if (/\{\{|\}\}/.test(rendered)) fail('模板渲染后仍有未替换的语法')
  else ok('模板能真实渲染，且无残留语法')
} catch {
  console.log('  - 未安装 art-template，跳过「真实渲染」这一步（其余检查不受影响）')
}

// ---------- 6. 帮助内容 ----------
console.log('\n【6】帮助内容')
const md = fs.readFileSync(path.join(pluginDir, 'resources', 'help', 'help.md'), 'utf8')
const groups = md.split(/^## /m).slice(1)
if (!groups.length) fail('help.md 没有解析出分组')
else ok(`help.md 有 ${groups.length} 个分组、${(md.match(/^- /gm) || []).length} 条`)
for (const g of groups) {
  const name = g.split('\n')[0].trim()
  if (!/^- /m.test(g)) fail(`分组「${name}」下面没有条目`)
}

// ---------- 7. 干净度 ----------
console.log('\n【7】交付物干净度')
const strays = fs.readdirSync(path.join(pluginDir, 'data')).filter((f) => f !== 'cfg_default.json')
if (strays.length) fail('data/ 里有残留文件：' + strays.join(', '))
else ok('data/ 只有 cfg_default.json')

for (const need of ['LICENSE', 'DISCLAIMER.md', 'README.md', 'package.json', 'index.js',
                    'resources/help/help.md', 'resources/help/theme/default/bg.jpg',
                    'resources/images/icon.png', 'resources/images/icon.svg']) {
  if (!fs.existsSync(path.join(pluginDir, need))) fail('缺少文件：' + need)
}
ok('许可 / 声明 / 帮助资源 / 入口文件都在')

const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
if (pkg.type !== 'module') fail('package.json 的 type 不是 module')
if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
  fail('声明了依赖，但插件设计为零依赖：' + JSON.stringify(pkg.dependencies))
} else ok('package.json 合法、零依赖、type=module')

// ---------- 8. 零依赖验证 ----------
// 这一条直接决定「拉下来之后要不要 pnpm i」：
// Yunzai 的 loader 只在 import 抛 "Cannot find package" 时才提示安装依赖，
// 所以只要没有任何第三方 import，就不会有那个提示 —— 也不该有。
console.log('\n【8】零依赖验证（决定要不要 pnpm i）')
const bareSpecs = new Set()
const nodeSpecs = new Set()
for (const f of [...moduleFiles, ...collect(pluginDir, (n) => n === 'offline-check.mjs')]) {
  const src = fs.readFileSync(f, 'utf8')
  const specs = [
    ...[...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ...[...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
  ]
  for (const s of specs) {
    if (s.startsWith('.')) continue
    if (s.startsWith('node:')) nodeSpecs.add(s)
    else bareSpecs.add(s)
  }
}
if (bareSpecs.size > 0) {
  fail('出现了第三方 import，安装后需要 pnpm i：' + [...bareSpecs].join(', '))
} else {
  ok(`没有任何第三方 import（只用 ${nodeSpecs.size} 个 node: 内置模块），安装后无需 pnpm i`)
}

console.log(`\n================ 一致性检查：${problems} 个问题 ================`)
process.exit(problems === 0 ? 0 : 1)
