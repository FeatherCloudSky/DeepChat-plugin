/**
 * 配置读写。
 *
 * 与参考实现的差别：
 *  - 不依赖 lodash，自带 deepMerge / getByPath；
 *  - 同时监听 data 目录，因此 cfg.json 在首次保存后才生成时，
 *    热重载依然有效（参考实现只在启动时文件已存在才挂 watcher）；
 *  - **只接受 cfg_default.json 里声明过的字段**，并检查类型。
 *    配置是「面板 → 插件」的写入入口，不加白名单就等于给了一个
 *    「往任意键上写任意值」的能力（`__proto__` 那类键更是直接改到原型链）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pluginData, pluginName } from '../config/constant.js'
import { deepMerge, getByPath, setByPath, isSafeKey } from './utils.js'
import { writeJsonAtomic } from './storage.js'

const DEFAULT_FILE = path.join(pluginData, 'cfg_default.json')
const USER_FILE = path.join(pluginData, 'cfg.json')

let cfg = {}
/** 默认配置的形状：字段名 -> 类型，用来做白名单和类型校验 */
let schema = new Map()
let reloadTimer = null

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return {}
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    logger.warn(`[${pluginName}] 读取 ${path.basename(file)} 失败：${error.message || error}`)
    return {}
  }
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

function buildSchema(defaults) {
  const map = new Map()
  for (const [key, value] of Object.entries(defaults)) {
    if (!isSafeKey(key)) continue
    map.set(key, typeOf(value))
  }
  return map
}

/** 丢掉 cfg.json 里默认配置没声明过的字段（旧版本残留、手工编辑、攻击者都算同一类） */
function pickKnown(source, known, { quiet = false } = {}) {
  const out = {}
  const dropped = []
  for (const [key, value] of Object.entries(source)) {
    if (!isSafeKey(key) || !known.has(key)) {
      dropped.push(key)
      continue
    }
    out[key] = value
  }
  if (dropped.length > 0 && !quiet) {
    logger.warn(`[${pluginName}] cfg.json 里有未定义的配置项，已忽略：${dropped.join(', ')}`)
  }
  return out
}

export function loadConfig() {
  const defaults = readJson(DEFAULT_FILE)
  schema = buildSchema(defaults)
  const user = pickKnown(readJson(USER_FILE), schema)
  cfg = deepMerge({}, pickKnown(defaults, schema, { quiet: true }), user)
  return cfg
}

loadConfig()

function scheduleReload(source) {
  clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => {
    loadConfig()
    logger.info(`[${pluginName}] 配置已热重载（${source}）`)
  }, 1000)
}

// 监听 data 目录而不是具体文件：这样 cfg.json 还不存在时也能覆盖到，
// 而且新建/替换文件（编辑器的「原子保存」）同样能被捕捉。
try {
  fs.watch(pluginData, (event, filename) => {
    if (!filename) return scheduleReload('目录变更')
    if (filename === 'cfg.json' || filename === 'cfg_default.json') return scheduleReload(filename)
  })
} catch (error) {
  logger.warn(`[${pluginName}] 配置热重载不可用：${error.message || error}`)
}

/**
 * 校验一次写入：字段必须在 schema 里，类型必须对得上，路径里不许有危险键。
 * @returns {{ok: true, value: any} | {ok: false, reason: string}}
 */
export function validatePair(key, value) {
  const name = String(key ?? '')
  if (!name) return { ok: false, reason: '空配置项' }
  if (name.includes('.')) {
    // 面板只写顶层字段；带点的路径一律拒绝，避免拼出预期之外的结构
    return { ok: false, reason: `不接受带路径的配置项：${name}` }
  }
  if (!isSafeKey(name)) return { ok: false, reason: `不安全的配置项：${name}` }
  if (!schema.has(name)) return { ok: false, reason: `未定义的配置项：${name}` }

  const expected = schema.get(name)
  const actual = typeOf(value)

  if (expected === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) return { ok: false, reason: `${name} 需要数字` }
    return { ok: true, value: n }
  }
  if (expected === 'boolean') {
    if (typeof value !== 'boolean') return { ok: false, reason: `${name} 需要布尔值` }
    return { ok: true, value }
  }
  if (expected === 'string') {
    if (typeof value !== 'string') return { ok: false, reason: `${name} 需要字符串` }
    return { ok: true, value }
  }
  if (expected === 'array') {
    if (Array.isArray(value)) return { ok: true, value }
    // 面板里用单行输入框填列表时是一串分隔符隔开的文本，这里统一拆开
    if (typeof value === 'string') {
      const items = value.split(/[,，;；\s]+/).map((item) => item.trim()).filter(Boolean)
      return { ok: true, value: items }
    }
    return { ok: false, reason: `${name} 需要数组` }
  }
  if (expected === 'object') {
    if (actual !== 'object') return { ok: false, reason: `${name} 需要对象` }
    return { ok: true, value }
  }
  return { ok: true, value }
}

/** 批量校验；任何一项不合法就整体拒绝 */
export function validatePairs(pairs) {
  const clean = {}
  const rejected = []
  for (const [key, value] of Object.entries(pairs ?? {})) {
    const result = validatePair(key, value)
    if (!result.ok) {
      rejected.push(result.reason)
      continue
    }
    clean[key] = result.value
  }
  return { ok: rejected.length === 0, clean, rejected }
}

const Cfg = {
  /** 读取配置项，取不到时用 def 兜底 */
  get(key, def) {
    return getByPath(cfg, key, def)
  },

  /** 读取并强制转成数字 */
  getNumber(key, def, min, max) {
    const value = Number(Cfg.get(key, def))
    if (!Number.isFinite(value)) return def
    let out = value
    if (min !== undefined) out = Math.max(min, out)
    if (max !== undefined) out = Math.min(max, out)
    return out
  },

  /** 读取并强制转成布尔 */
  getBool(key, def) {
    const value = Cfg.get(key, def)
    if (typeof value === 'boolean') return value
    if (value === 'true' || value === 1 || value === '1') return true
    if (value === 'false' || value === 0 || value === '0') return false
    return def
  },

  /** 读取 ID 列表（统一成字符串数组） */
  getIdList(key) {
    const value = Cfg.get(key, [])
    if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
    if (value === undefined || value === null || value === '') return []
    return String(value)
      .split(/[,，;；\s]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  },

  /**
   * 查询指定模型是否支持图片输入。
   * 匹配顺序：精确匹配 modelVision 里的 key -> key 为 "*" 的通配项 -> defaultVision。
   * 模型名忽略大小写（面板里写 DeepSeek-Flash 而配置里写 deepseek-flash 也不该漏）。
   */
  visionFor(model) {
    const target = String(model ?? '').trim()
    const lower = target.toLowerCase()
    const list = Cfg.get('modelVision', [])

    if (Array.isArray(list)) {
      const rows = list.filter((row) => row && typeof row === 'object')
      const keyOf = (row) => String(row.key ?? '').trim().toLowerCase()

      const exact = rows.find((row) => target !== '' && keyOf(row) === lower)
      if (exact && typeof exact.vision === 'boolean') return exact.vision

      const wildcard = rows.find((row) => String(row.key ?? '').trim() === '*')
      if (wildcard && typeof wildcard.vision === 'boolean') return wildcard.vision
    }

    return Cfg.getBool('defaultVision', false)
  },

  /** 返回完整配置（默认值 + 用户值）的深拷贝 */
  getAll() {
    return JSON.parse(JSON.stringify(cfg))
  },

  set(key, value) {
    const checked = validatePair(key, value)
    if (!checked.ok) {
      logger.warn(`[${pluginName}] 拒绝写入配置：${checked.reason}`)
      return false
    }
    const previous = Cfg.getAll()
    try {
      setByPath(cfg, key, checked.value)
    } catch (error) {
      logger.warn(`[${pluginName}] 拒绝写入配置：${error.message || error}`)
      return false
    }
    if (Cfg.save()) return true
    cfg = previous
    return false
  },

  /** 批量写入，只落盘一次（锅巴保存时会一次性传很多字段） */
  setMany(pairs) {
    const checked = validatePairs(pairs)
    if (!checked.ok) {
      logger.warn(`[${pluginName}] 配置里有不合法或未定义的字段，整次保存已取消：${checked.rejected.join('；')}`)
      return false
    }
    const previous = Cfg.getAll()
    try {
      for (const [key, value] of Object.entries(checked.clean)) {
        setByPath(cfg, key, value)
      }
    } catch (error) {
      logger.warn(`[${pluginName}] 写入配置失败：${error.message || error}`)
      cfg = previous
      return false
    }
    if (Cfg.save()) return true
    cfg = previous
    return false
  },

  save() {
    try {
      writeJsonAtomic(USER_FILE, Cfg.getAll())
      return true
    } catch (error) {
      logger.error(`[${pluginName}] 保存 cfg.json 失败：${error.message || error}`)
      return false
    }
  },

  reload: loadConfig,

  /** 当前 schema 的字段名（测试与面板校验用） */
  schemaKeys() {
    return [...schema.keys()]
  },

  validatePair,
  validatePairs,

  files: { DEFAULT_FILE, USER_FILE }
}

export default Cfg
