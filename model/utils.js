/**
 * 通用小工具。刻意不依赖 lodash / openai，
 * 让插件做到「零安装依赖」—— 克隆下来就能用。
 */

/** 判断空值（undefined / null / 空字符串 / 纯空白） */
export function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === ''
}

/** 递归合并普通对象，返回 target 本身 */
export function deepMerge(target, ...sources) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue
    for (const [key, value] of Object.entries(source)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const base = target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
          ? target[key]
          : {}
        target[key] = deepMerge(base, value)
      } else {
        target[key] = Array.isArray(value) ? value.slice() : value
      }
    }
  }
  return target
}

/** 按 "a.b.c" 取值，取不到返回 def */
export function getByPath(obj, path, def) {
  if (!path) return def
  let cur = obj
  for (const part of String(path).split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return def
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return def
    cur = cur[part]
  }
  return cur === undefined ? def : cur
}

/** 按 "a.b.c" 赋值 */
export function setByPath(obj, path, value) {
  const parts = String(path).split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (!cur[part] || typeof cur[part] !== 'object') cur[part] = {}
    cur = cur[part]
  }
  cur[parts[parts.length - 1]] = value
  return obj
}

/**
 * 把各种形态的「ID 列表」归一成字符串数组。
 * 支持数组，以及用英文/中文逗号、分号、空白分隔的字符串。
 * 统一成字符串是为了让 123 和 "123" 能正确相等。
 */
export function parseIdList(value) {
  if (value === undefined || value === null || value === '') return []
  const raw = Array.isArray(value) ? value : String(value).split(/[,，;；\s]+/)
  const out = []
  for (const item of raw) {
    const id = String(item ?? '').trim()
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/** 判断 id 是否在列表中（忽略数字/字符串差异） */
export function idIn(list, id) {
  const target = String(id ?? '')
  if (!target) return false
  return parseIdList(list).includes(target)
}

/**
 * 从 apiKey 字段里随机取一个 key。
 * 支持英文逗号、中文逗号、分号、换行分隔的多个 key。
 */
export function pickApiKey(raw) {
  const keys = String(raw ?? '')
    .replace(/[，；;]/g, ',')
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
  if (keys.length === 0) return ''
  return keys[Math.floor(Math.random() * keys.length)]
}

/** 数值兜底与裁剪 */
export function toNumber(value, def, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return def
  let out = n
  if (min !== undefined) out = Math.max(min, out)
  if (max !== undefined) out = Math.min(max, out)
  return out
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 判断一个 URL 是不是「公网 http(s)」。
 *
 * 用途：图片下载是服务端发起的请求，而 URL 来自群消息（不可信输入），
 * 直接照单全收就变成一个 SSRF 口子 —— 有人发一张 url 指向 127.0.0.1 或
 * 内网地址的图，机器人就替他去请求内网了。
 *
 * 注意：这里只做字面量的地址判定，**不做 DNS 解析**。
 * 攻击者用一个解析到内网 IP 的域名仍然能绕过，要彻底堵住得在下载时
 * 解析并核对对端 IP，那超出这个插件的职责了。
 */
export function isPublicHttpUrl(value) {
  let url
  try {
    url = new URL(String(value ?? ''))
  } catch {
    return false
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false

  const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!host) return false

  if (host === 'localhost' || host.endsWith('.localhost')) return false
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return false

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const a = Number(ipv4[1])
    const b = Number(ipv4[2])
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 100 && b >= 64 && b <= 127) return false
  }

  return true
}

/**
 * 把一段回复按句号 / 问号 / 感叹号 / 换行拆成多条。
 *
 * 与常见实现的区别：
 *  1. 用后行断言切分，标点会【保留】在上一句结尾，不会丢；
 *  2. 连续的终止符（如「真的吗？？」）不会被切开；
 *  3. 原文过长或段数过多时整段返回，避免刷屏。
 */
export function splitReply(text, options = {}) {
  const maxSegments = toNumber(options.maxSegments, 5, 1, 50)
  const maxLength = toNumber(options.maxLength, 500, 1, 100000)

  if (typeof text !== 'string') return []
  const clean = text.replace(/<EMPTY>/gi, '').trim()
  if (!clean) return []

  const segments = clean
    .split(/(?<=[。？！?!])(?![。？！?!\n])|\n+/)
    .map((item) => item.trim())
    .filter(Boolean)

  if (segments.length <= 1) return segments
  if (clean.length >= maxLength || segments.length > maxSegments) return [clean]
  return segments
}

/** 取数组里第一个「有值」的参数，用于多级兜底 */
export function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value
  }
  return undefined
}
