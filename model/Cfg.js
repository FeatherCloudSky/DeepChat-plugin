/**
 * 配置读写。
 *
 * 与参考实现的差别：
 *  - 不依赖 lodash，自带 deepMerge / getByPath；
 *  - 同时监听 data 目录，因此 cfg.json 在首次保存后才生成时，
 *    热重载依然有效（参考实现只在启动时文件已存在才挂 watcher）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pluginData, pluginName } from '../config/constant.js'
import { deepMerge, getByPath, setByPath } from './utils.js'

const DEFAULT_FILE = path.join(pluginData, 'cfg_default.json')
const USER_FILE = path.join(pluginData, 'cfg.json')

let cfg = {}
let reloadTimer = null

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return {}
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    logger.warn(`[${pluginName}] 读取 ${path.basename(file)} 失败：${error.message || error}`)
    return {}
  }
}

export function loadConfig() {
  cfg = deepMerge({}, readJson(DEFAULT_FILE), readJson(USER_FILE))
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
   */
  visionFor(model) {
    const target = String(model ?? '').trim()
    const list = Cfg.get('modelVision', [])

    if (Array.isArray(list)) {
      const rows = list.filter((row) => row && typeof row === 'object')

      const exact = rows.find((row) => String(row.key ?? '').trim() === target && target !== '')
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
    setByPath(cfg, key, value)
    Cfg.save()
  },

  /** 批量写入，只落盘一次（锅巴保存时会一次性传很多字段） */
  setMany(pairs) {
    for (const [key, value] of Object.entries(pairs ?? {})) {
      setByPath(cfg, key, value)
    }
    return Cfg.save()
  },

  save() {
    try {
      fs.mkdirSync(pluginData, { recursive: true })
      fs.writeFileSync(USER_FILE, JSON.stringify(Cfg.getAll(), null, '\t'), 'utf8')
      return true
    } catch (error) {
      logger.error(`[${pluginName}] 保存 cfg.json 失败：${error.message || error}`)
      return false
    }
  },

  reload: loadConfig,

  files: { DEFAULT_FILE, USER_FILE }
}

export default Cfg
