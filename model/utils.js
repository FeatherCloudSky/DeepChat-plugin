/**
 * 通用小工具。刻意不依赖 lodash / openai，
 * 让插件做到「零安装依赖」—— 克隆下来就能用。
 */
import net from 'node:net'
import { classifyAddress } from './net.js'

/** 判断空值（undefined / null / 空字符串 / 纯空白） */
export function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === ''
}

/**
 * 这些键一旦被当成「普通字段」写进对象，就会改到整条原型链上 ——
 * 配置里出现一个 `__proto__.isMaster` 就能让同进程里所有对象都继承它。
 * 所有「按键写入」的地方都要先过这一关。
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function isSafeKey(key) {
  return typeof key === 'string' && key !== '' && !UNSAFE_KEYS.has(key)
}

/** 递归合并普通对象，返回 target 本身。危险键直接丢弃，不参与合并。 */
export function deepMerge(target, ...sources) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue
    for (const [key, value] of Object.entries(source)) {
      if (!isSafeKey(key)) continue
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

/**
 * 按 "a.b.c" 赋值。
 * 路径里出现 __proto__ / constructor / prototype 时直接拒绝并抛错 ——
 * 这类键不是「配置项」，写进去只会污染原型。
 */
export function setByPath(obj, path, value) {
  const parts = String(path).split('.')
  for (const part of parts) {
    if (!isSafeKey(part)) throw new Error(`不安全的配置键：${path}`)
  }
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (!Object.prototype.hasOwnProperty.call(cur, part) ||
        !cur[part] || typeof cur[part] !== 'object' || Array.isArray(cur[part])) {
      cur[part] = {}
    }
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

/** 把 apiKey 字段拆成去重后的 key 列表 */
export function apiKeyList(raw) {
  const keys = String(raw ?? '')
    .replace(/[，；;]/g, ',')
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
  return [...new Set(keys)]
}

/**
 * 从 apiKey 字段里随机取一个 key。
 * 支持英文逗号、中文逗号、分号、换行分隔的多个 key。
 */
export function pickApiKey(raw) {
  const keys = apiKeyList(raw)
  if (keys.length === 0) return ''
  return keys[Math.floor(Math.random() * keys.length)]
}

/**
 * 重试时换一个 key。
 *
 * 原来每次重试都是「在全部 key 里再随机取一个」，于是取回同一个 key 是常态 ——
 * 换 Key 重试并没有真的发生。这里排除掉上一次用过的那个。
 */
export function pickApiKeyExcept(raw, avoid) {
  const keys = apiKeyList(raw)
  if (keys.length === 0) return ''
  const pool = keys.filter((key) => key !== avoid)
  const pick = pool.length > 0 ? pool : keys
  return pick[Math.floor(Math.random() * pick.length)]
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
 * 判断一个 URL 是不是「字面上的公网 http(s) 地址」。
 *
 * 用途：图片下载是服务端发起的请求，而 URL 来自群消息（不可信输入），
 * 直接照单全收就变成一个 SSRF 口子 —— 有人发一张 url 指向 127.0.0.1 或
 * 内网地址的图，机器人就替他去请求内网了。
 *
 * 注意：这里**只做字面量判断，不做 DNS 解析**，所以它只是「第一道粗筛」。
 * 真正发起请求前必须交给 model/net.js 的 assertUrlAllowed / request：
 * 那里会解析域名、逐个核对解析出来的地址，并把连接钉在审核过的 IP 上。
 */
export function isPublicHttpUrl(value) {
  let url
  try {
    url = new URL(String(value ?? ''))
  } catch {
    return false
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username || url.password) return false

  const host = String(url.hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '')
  if (!host) return false

  // 这些后缀几乎只出现在内网 / 局域网
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home|corp|intranet)$/.test(host)) return false

  // IP 字面量：交给统一的地址分类，IPv4 映射 IPv6、6to4、NAT64 都会被正确归类
  if (net.isIP(host)) return classifyAddress(host) === 'public'

  // 不含点也不含冒号的主机名（如 http://intranet/）只能是内网名
  return host.includes('.') || host.includes(':')
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

/** 这些地址不给拉：云厂商的元数据服务，SSRF 最经典的目标 */
const BLOCKED_META_HOSTS = new Set([
  '100.100.100.200',            // 阿里云元数据
  '169.254.169.254',            // AWS / GCP / Azure 元数据
  'metadata.google.internal',
  'metadata.tencentyun.com',
  'metadata.azure.com'
])

/**
 * 「这个 http(s) 地址值不值得去拉」—— 给**适配器自己提供**的资源用。
 *
 * 因为不少适配器（OneBot 系的 NapCat、Lagrange）是拿本机的一个 HTTP 端口
 * 供图和供文件的，地址就是 http://127.0.0.1:xxxx/xxx —— 按「只收公网」的
 * 规矩会把这整类资源挡掉，表现就是「明明有图/有文件，插件却拿不到」。
 * 所以它和 isPublicHttpUrl 是两套规则，**不能拿它去判断群消息里的地址**。
 *
 * 即便调用方是适配器资源，真正发请求时也要走 net.js 的审核 + 白名单，
 * 这里只负责拒掉明显不该碰的目标。
 */
export function isFetchableUrl(value) {
  let url
  try {
    url = new URL(String(value ?? ''))
  } catch (error) {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username || url.password) return false

  const host = String(url.hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!host) return false
  if (BLOCKED_META_HOSTS.has(host)) return false

  if (net.isIP(host)) {
    if (classifyAddress(host) === 'invalid') return false
    // 链路本地（含 169.254.169.254）与组播一律不碰；回环/私网交给白名单决定
    if (/^169\.254\./.test(host)) return false
    return true
  }
  return true
}

/**
 * 模型输出要经过聊天协议发送。有的宿主会把字符串里的 `[CQ:...]` 重新解释成
 * 图片 / 文件消息段 —— 那就等于让模型（以及能影响模型的群消息）指挥机器人发东西。
 * 这里只把 CQ 的起始标记换成全角左括号：语义上不再构成 CQ 码，看上去还是「[」。
 */
export function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '［CQ:')
}

/**
 * 这条消息引用了哪条消息（QQ 的「引用回复」）。
 * 三个来源都试一遍：Yunzai 的 e.reply_id、e.source、以及消息段里的 reply 段。
 */
export function replyIdOf(e) {
  if (!e) return ''
  if (e.reply_id) return String(e.reply_id)
  if (e.source && e.source.message_id) return String(e.source.message_id)
  const segments = Array.isArray(e.message) ? e.message : []
  const replySeg = segments.find((seg) => seg && seg.type === 'reply')
  return replySeg && replySeg.id ? String(replySeg.id) : ''
}

/**
 * 按 id 找出被引用的那条消息（拿到的是原始消息段数组）。
 *
 * 为什么需要这个：QQ 里「引用一条消息」时，被引用的文字和图片都在**那条**消息里，
 * 当前消息只带一个 reply 段，直接看 e.message 是看不到内容的。
 *
 * icqq 没有按 id 取单条消息的接口（Group/Friend 只有 getChatHistory 和 recallMsg），
 * 所以只能翻最近的聊天记录把它找出来。引用的通常都是刚看过的消息，够用。
 *
 * @param {number[]} windows 依次尝试的翻页条数。翻记录有成本，先试小的再试大的。
 * @returns {Promise<object|null>} 被引用的消息，找不到返回 null
 */
export async function findQuotedMessage(e, windows = [30]) {
  const replyId = replyIdOf(e)
  if (!replyId) return null

  const target = e?.isGroup ? e?.group : e?.friend
  if (typeof target?.getChatHistory !== 'function') return null

  for (const count of windows) {
    if (!(count > 0)) continue
    let recent = null
    try {
      recent = await target.getChatHistory(0, count)
    } catch (error) {
      logger.debug(`[utils] 读取被引用消息失败：${error.message || error}`)
      return null
    }
    const hit = (recent || []).find((msg) => String(msg?.message_id) === replyId)
    if (hit) return hit
  }

  return null
}
