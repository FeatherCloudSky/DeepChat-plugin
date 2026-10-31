/** 仅在临时副本中测试锅巴预设的保存、选择、删除和持久化。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runIsolated } from './isolated-workspace.mjs'

runIsolated(fileURLToPath(import.meta.url))
globalThis.logger = Object.fromEntries(['info', 'warn', 'error', 'debug', 'mark'].map(k => [k, () => {}]))
globalThis.logger.error = console.error
globalThis.logger.warn = console.error
globalThis.plugin = class { constructor(config) { Object.assign(this, config) } }
const { default: Cfg } = await import('../model/Cfg.js')
const { supportGuoba } = await import('../guoba.support.js')
const panel = () => supportGuoba().configInfo
const Result = { ok: () => ({ ok: true }), error: message => ({ ok: false, message }) }
const save = data => panel().setConfigData(data, { Result })
const values = key => Cfg.get(key, []).map(row => row.value)
let checks = 0
function check(name, actual, expected) { assert.deepEqual(actual, expected, name); checks++; console.log(`PASS ${name}`) }
const group = panel().schemas.find(row => row.field === 'existingConfig')
check('四个选项位于单个折叠入口', group.componentProps.schemas.map(row => row.field), ['selectSavedModel', 'selectSavedApiUrl', 'savedModels', 'savedApiUrls'])

// 模拟旧版已配置的数据，不依赖真实密钥和用户配置。
check('设置旧配置', Cfg.setMany({ model: 'legacy-model', apiUrl: 'https://legacy.invalid/v1', apiKey: 'TEST_OLD_KEY' }), true)
check('保存旧配置', save({ model: 'legacy-model', apiUrl: 'https://legacy.invalid/v1', apiKey: 'TEST_OLD_KEY' }).ok, true)
check('旧模型自动记忆', values('savedModels'), ['legacy-model'])
check('旧地址自动记忆', values('savedApiUrls'), ['https://legacy.invalid/v1'])
check('旧 Key 保持不变', Cfg.get('apiKey'), 'TEST_OLD_KEY')

check('手动新增模型和地址', save({ model: 'model-two', apiUrl: 'https://second.invalid/v1', apiKey: 'TEST_NEW_KEY' }).ok, true)
check('两个模型均保存', values('savedModels'), ['legacy-model', 'model-two'])
check('两个地址均保存', values('savedApiUrls'), ['https://legacy.invalid/v1', 'https://second.invalid/v1'])
const grouped = panel().getConfigData().existingConfig
check('折叠入口读取已保存模型', grouped.savedModels, ['legacy-model', 'model-two'])
check('折叠入口选择已保存模型', save({ existingConfig: { ...grouped, selectSavedModel: 'legacy-model' } }).ok, true)
check('折叠入口选择生效', Cfg.get('model'), 'legacy-model')
check('切换地址时明确更新 Key 可用', Cfg.get('apiKey'), 'TEST_NEW_KEY')
const childFields = panel().schemas.find(field => field.field === 'existingConfig').componentProps.schemas
const modelOptions = childFields.find(field => field.field === 'selectSavedModel').componentProps.options.map(option => option.value)
const urlOptions = childFields.find(field => field.field === 'selectSavedApiUrl').componentProps.options.map(option => option.value)
check('重新打开面板可以选择模型', modelOptions, ['', 'legacy-model', 'model-two'])
check('重新打开面板可以选择地址', urlOptions, ['', 'https://legacy.invalid/v1', 'https://second.invalid/v1'])

check('选择已有模型', save({ selectSavedModel: 'legacy-model' }).ok, true)
check('选择模型生效', Cfg.get('model'), 'legacy-model')
check('选择模型不影响 Key', Cfg.get('apiKey'), 'TEST_NEW_KEY')
check('选择已有地址', save({ selectSavedApiUrl: 'https://legacy.invalid/v1', apiKey: 'TEST_NEW_KEY' }).ok, true)
check('选择地址生效', Cfg.get('apiUrl'), 'https://legacy.invalid/v1')
check('切换地址不沿用旧 Key', Cfg.get('apiKey'), '')

check('折叠入口删除当前记录', save({ existingConfig: { savedModels: ['model-two'], savedApiUrls: ['https://second.invalid/v1'] } }).ok, true)
check('删除后模型列表', values('savedModels'), ['model-two'])
check('删除后地址列表', values('savedApiUrls'), ['https://second.invalid/v1'])
check('删除当前记录不改变模型', Cfg.get('model'), 'legacy-model')
check('删除当前记录不改变地址', Cfg.get('apiUrl'), 'https://legacy.invalid/v1')
Cfg.reload()
check('重新加载保留删除结果', [values('savedModels'), values('savedApiUrls')], [['model-two'], ['https://second.invalid/v1']])
check('重启加载保留当前模型与地址', [Cfg.get('model'), Cfg.get('apiUrl')], ['legacy-model', 'https://legacy.invalid/v1'])
const reloaded = spawnSync(process.execPath, ['--input-type=module', '-e', `
  globalThis.logger = Object.fromEntries(['info','warn','error','debug','mark'].map(k => [k, () => {}]));
  const { default: cfg } = await import('./model/Cfg.js');
  console.log(JSON.stringify({ model: cfg.get('model'), apiUrl: cfg.get('apiUrl'), savedModels: cfg.get('savedModels'), savedApiUrls: cfg.get('savedApiUrls') }));
  process.exit(0);
`], { cwd: process.cwd(), encoding: 'utf8' })
check('新进程读取持久配置成功', reloaded.status, 0)
const restarted = JSON.parse(reloaded.stdout)
check('新进程读取当前模型与地址', [restarted.model, restarted.apiUrl], ['legacy-model', 'https://legacy.invalid/v1'])
check('新进程保留删除结果', [restarted.savedModels, restarted.savedApiUrls], [[{ value: 'model-two' }], [{ value: 'https://second.invalid/v1' }]])

const before = Cfg.getAll()
check('拒绝选择不存在的模型', save({ selectSavedModel: 'missing' }).ok, false)
check('拒绝选择不存在的地址', save({ selectSavedApiUrl: 'https://missing.invalid' }).ok, false)
check('无效选择不改变配置', Cfg.getAll(), before)
check('拒绝错误字段', save({ model: 'SHOULD_NOT_SAVE', '__proto__.x': true }).ok, false)
check('错误输入原子回滚', Cfg.getAll(), before)
Cfg.reload()
check('错误输入没有写入磁盘', Cfg.getAll(), before)
check('拒绝保存含密码的地址', save({ savedApiUrls: [{ value: 'https://user:SECRET@service.invalid' }] }).ok, false)
check('拒绝保存含查询密钥的地址', save({ apiUrl: 'https://service.invalid/v1?key=SECRET' }).ok, false)
check('拒绝含凭据地址后无配置变更', Cfg.getAll(), before)
check('预设列表不存储 Key', JSON.stringify([Cfg.get('savedModels'), Cfg.get('savedApiUrls')]).includes('TEST_'), false)

const rename = fs.renameSync
try {
  fs.renameSync = () => { throw new Error('模拟写入失败') }
  check('写入失败时面板返回错误', save({ model: 'write-failed' }).ok, false)
} finally { fs.renameSync = rename }
check('写入失败恢复内存', Cfg.getAll(), before)
Cfg.reload()
check('写入失败未改变磁盘', Cfg.getAll(), before)

check('设置旧版带查询参数的地址', Cfg.setMany({ apiUrl: 'https://legacy.invalid/v1?key=OLD_SECRET', model: 'old-model', apiKey: 'OLD_KEY', savedModels: [], savedApiUrls: [], presetMemoryInitialized: false }), true)
check('旧地址不阻碍保存其他配置', save({ temperature: 0.7 }).ok, true)
check('旧地址保持不变', Cfg.get('apiUrl'), 'https://legacy.invalid/v1?key=OLD_SECRET')
check('旧地址的凭据不进入预设', values('savedApiUrls'), [])
check('旧模型仍被记忆', values('savedModels'), ['old-model'])
Cfg.reload()
check('旧配置保持可读取', Cfg.get('apiUrl'), 'https://legacy.invalid/v1?key=OLD_SECRET')
check('手动更换 API 地址', save({ apiUrl: 'https://manual.invalid/v1', apiKey: 'OLD_KEY' }).ok, true)
check('手动更换地址清空未更改的 Key', Cfg.get('apiKey'), '')
check('手动更换的地址自动记忆', values('savedApiUrls'), ['https://manual.invalid/v1'])

console.log(`模型与地址预设：${checks} 项通过`)
process.exit(0)
