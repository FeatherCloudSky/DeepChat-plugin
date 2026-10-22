/**
 * 出站请求的唯一入口：解析、复查、钉住地址，再发请求。
 *
 * 为什么不能直接用 fetch：
 *  1. fetch 会自己解析 DNS，我们没法在「解析之后、连接之前」核对对端 IP，
 *     于是「域名解析到 127.0.0.1」这种最经典的 SSRF 绕过挡不住；
 *  2. fetch 默认跟随跳转，下一跳不会重新审核，公网地址跳内网就绕过了所有检查；
 *  3. fetch 的响应体没有内建字节上限，超时也只能靠 AbortController。
 *
 * 这里的做法（Node 16 的 http/https 也支持，不引入任何依赖）：
 *   - 自己 dns.lookup({ all: true })，逐个核对地址，只保留允许的连接目标；
 *   - 通过 http.request 的 lookup 回调把连接钉在审核过的地址上，
 *     因此「审核的地址」和「实际连接的地址」一定是同一个，没有二次解析窗口；
 *   - 跳转由我们自己处理，每一跳都重新走一遍上面的流程，默认根本不允许跳转；
 *   - 读响应时按 maxBytes 截断、按整条请求的 deadline 中断，
 *     持续滴流拖时间的服务端也会被掐掉。
 *
 * 判定策略由调用方给出，本模块不认识配置：
 *   allowPrivate  —— 是否允许内网/回环目标（运营者显式配置的 API 地址才该开）
 *   allowLoopback —— 是否允许 127.0.0.1 / ::1
 *   allowHosts    —— 额外的 host:port 白名单（适配器本机供图这类）
 */
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

/** 目标被安全规则拒绝。调用方可以据此给用户一句明确的说明。 */
export class BlockedTargetError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BlockedTargetError'
    this.code = 'EBLOCKEDTARGET'
  }
}

/** 请求超时 / 超过体积上限 */
export class TransferLimitError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TransferLimitError'
    this.code = 'ETRANSFERLIMIT'
  }
}

// ---------------------------------------------------------------- 地址分类

function v4ToInt(ip) {
  const parts = String(ip).split('.')
  if (parts.length !== 4) return null
  let out = 0
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    out = out * 256 + n
  }
  return out >>> 0
}

/** 需要挡住的 IPv4 网段（写全，别只挡 10/172/192 三段） */
const V4_BLOCKED_CIDRS = [
  ['0.0.0.0', 8],        // 本网络
  ['10.0.0.0', 8],       // 私有
  ['100.64.0.0', 10],    // 运营商级 NAT
  ['127.0.0.0', 8],      // 回环
  ['169.254.0.0', 16],   // 链路本地（含云元数据 169.254.169.254）
  ['172.16.0.0', 12],    // 私有
  ['192.0.0.0', 24],     // IETF 协议分配
  ['192.0.2.0', 24],     // 文档用
  ['192.88.99.0', 24],   // 6to4 中继
  ['192.168.0.0', 16],   // 私有
  ['198.18.0.0', 15],    // 基准测试
  ['198.51.100.0', 24],  // 文档用
  ['203.0.113.0', 24],   // 文档用
  ['224.0.0.0', 4],      // 组播
  ['240.0.0.0', 4]       // 保留 / 广播
].map(([base, bits]) => ({ base: v4ToInt(base), bits }))

function inV4Cidr(value, cidr) {
  if (value === null) return false
  const shift = 32 - cidr.bits
  if (shift === 0) return true
  return (value >>> shift) === (cidr.base >>> shift)
}

/** 把 IPv6 文本展开成 8 个 16 位分组；失败返回 null */
export function parseIPv6(address) {
  let text = String(address ?? '').trim().toLowerCase()
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  if (!text || !text.includes(':')) return null
  if (text.includes('.')) {
    // 末尾内嵌 IPv4（::ffff:127.0.0.1 / 64:ff9b::1.2.3.4）
    const at = text.lastIndexOf(':')
    const v4 = v4ToInt(text.slice(at + 1))
    if (v4 === null) return null
    text = `${text.slice(0, at + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }

  const halves = text.split('::')
  if (halves.length > 2) return null
  const toGroups = (part) => (part ? part.split(':') : [])
  const head = toGroups(halves[0])
  const tail = halves.length === 2 ? toGroups(halves[1]) : []
  const groups = [...head, ...tail]
  if (halves.length === 2) {
    if (groups.length > 7) return null
    const fill = new Array(8 - groups.length).fill('0')
    groups.splice(head.length, 0, ...fill)
  }
  if (groups.length !== 8) return null

  const out = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    out.push(parseInt(group, 16))
  }
  return out
}

/** IPv6 里内嵌的 IPv4（mapped / NAT64 / 6to4），取不到返回 null */
function embeddedV4(groups) {
  const zeroPrefix = (count) => groups.slice(0, count).every((g) => g === 0)
  // ::ffff:a.b.c.d
  if (zeroPrefix(5) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`
  }
  // 64:ff9b::a.b.c.d（NAT64）
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`
  }
  // 2002:xxxx:xxxx::（6to4，前 6 字节里嵌了 IPv4）
  if (groups[0] === 0x2002) {
    return `${groups[1] >> 8}.${groups[1] & 0xff}.${groups[2] >> 8}.${groups[2] & 0xff}`
  }
  return null
}

/**
 * 地址分类：'loopback' | 'private' | 'public' | 'invalid'
 * 内网、回环、链路本地、组播、保留段、以及「看起来像公网其实是内嵌 IPv4」的
 * 各种写法，都在这里归类。
 */
export function classifyAddress(address) {
  const text = String(address ?? '').trim()
  const family = net.isIP(text)

  if (family === 4) {
    const value = v4ToInt(text)
    if (value === null) return 'invalid'
    if ((value >>> 24) === 127) return 'loopback'
    for (const cidr of V4_BLOCKED_CIDRS) {
      if (inV4Cidr(value, cidr)) return 'private'
    }
    return 'public'
  }

  if (family !== 6) return 'invalid'

  const groups = parseIPv6(text)
  if (!groups) return 'invalid'

  const zeroPrefix = (count) => groups.slice(0, count).every((g) => g === 0)
  if (zeroPrefix(7) && groups[7] === 1) return 'loopback'          // ::1
  if (zeroPrefix(8)) return 'private'                              // ::

  // 内嵌 IPv4：按内嵌地址判断（::ffff:127.0.0.1 就是回环）
  const inner = embeddedV4(groups)
  if (inner) {
    const innerClass = classifyAddress(inner)
    return innerClass === 'public' ? 'public' : innerClass
  }

  if ((groups[0] & 0xfe00) === 0xfc00) return 'private'            // fc00::/7 ULA
  if ((groups[0] & 0xffc0) === 0xfe80) return 'private'            // fe80::/10 链路本地
  if ((groups[0] & 0xff00) === 0xff00) return 'private'            // ff00::/8 组播
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return 'private' // 文档用
  if (groups[0] === 0x2001 && groups[1] === 0x0000) return 'private' // Teredo

  return 'public'
}

export const isPublicAddress = (address) => classifyAddress(address) === 'public'
export const isLoopbackAddress = (address) => classifyAddress(address) === 'loopback'

const LOOPBACK_HOSTS = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback'])

export function isLoopbackHost(hostname) {
  const host = String(hostname ?? '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '')
  if (!host) return false
  if (LOOPBACK_HOSTS.has(host)) return true
  return isLoopbackAddress(host)
}

/** 去掉可能带凭据、query、fragment 的地址，只留 origin + 第一段路径，供日志/状态使用 */
export function redactUrl(value) {
  let url
  try {
    url = new URL(String(value ?? ''))
  } catch {
    return '(无法解析的地址)'
  }
  const path = url.pathname && url.pathname !== '/' ? `${url.pathname.split('/').slice(0, 3).join('/')}/…` : '/'
  return `${url.protocol}//${url.host}${path}`
}

// ---------------------------------------------------------------- 解析与审核

function normalizeHost(hostname) {
  return String(hostname ?? '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '')
}

function hostKey(hostname, port) {
  return `${normalizeHost(hostname)}:${port}`
}

/**
 * 把主机名解析成地址列表。
 * 主机名本身就是 IP 字面量时不查 DNS（也就没有二次解析的余地）。
 */
export async function resolveHost(hostname) {
  const host = normalizeHost(hostname)
  if (!host) throw new BlockedTargetError('目标地址缺少主机名')

  const literalFamily = net.isIP(host)
  if (literalFamily) return [{ address: host, family: literalFamily }]

  let rows
  try {
    rows = await dns.promises.lookup(host, { all: true, verbatim: true })
  } catch (error) {
    throw new BlockedTargetError(`目标域名无法解析：${host}`)
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new BlockedTargetError(`目标域名没有解析结果：${host}`)
  }
  return rows.map((row) => ({ address: String(row.address), family: row.family || net.isIP(row.address) }))
}

/**
 * 解析 + 审核，返回可以连接的地址列表。
 * 只要解析结果里没有任何一个地址是允许的，就整体拒绝 ——
 * 不做「挑一个能连的」这种兜底，那等于把判断交给攻击者控制的那一半解析结果。
 */
export async function resolveAllowed(hostname, options = {}) {
  const { allowPrivate = false, allowLoopback = false, allowHosts = [] } = options
  const host = normalizeHost(hostname)
  const port = Number(options.port ?? 0)

  if (allowHosts.some((item) => String(item ?? '').toLowerCase() === hostKey(host, port))) {
    const rows = await resolveHost(host)
    return rows
  }

  const rows = await resolveHost(host)
  const allowed = rows.filter((row) => {
    const kind = classifyAddress(row.address)
    if (kind === 'public') return true
    if (kind === 'loopback') return allowLoopback
    if (kind === 'private') return allowPrivate
    return false
  })

  if (allowed.length === 0) {
    const kinds = [...new Set(rows.map((row) => classifyAddress(row.address)))].join('/')
    throw new BlockedTargetError(`目标地址指向非公网范围（${kinds}），已拒绝连接：${host}`)
  }
  return allowed
}

/** 审核一个 URL 是否允许请求（只做地址判断，不发请求） */
export async function assertUrlAllowed(rawUrl, options = {}) {
  const url = new URL(String(rawUrl))
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedTargetError(`只支持 http/https 地址，收到的是 ${url.protocol}`)
  }
  if (options.requireHttps && url.protocol !== 'https:') {
    throw new BlockedTargetError('出于安全要求，该地址必须使用 HTTPS')
  }
  if (url.username || url.password) {
    throw new BlockedTargetError('地址里不允许携带用户名或密码')
  }
  await resolveAllowed(url.hostname, {
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    allowPrivate: options.allowPrivate,
    allowLoopback: options.allowLoopback,
    allowHosts: options.allowHosts
  })
  return url
}

// ---------------------------------------------------------------- 请求

/** 把连接钉在指定地址上：Node 会用这个回调的结果去连，不会自己再解析一次 */
function pinnedLookup(rows) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }
    if (options && options.all) {
      callback(null, rows.map((row) => ({ address: row.address, family: row.family })))
      return
    }
    const first = rows[0]
    callback(null, first.address, first.family)
  }
}

function encodeBody(body) {
  if (body === null || body === undefined) return null
  if (Buffer.isBuffer(body)) return body
  if (typeof body === 'string') return Buffer.from(body)
  return Buffer.from(JSON.stringify(body))
}

/**
 * 发一次请求，读完整响应。
 *
 * @returns {Promise<{status:number, headers:object, buffer:Buffer}>}
 */
function requestOnce(url, rows, options) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeoutMs = 15000,
    maxBytes = 8 * 1024 * 1024
  } = options

  const payload = encodeBody(body)
  const lib = url.protocol === 'https:' ? https : http

  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null

    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      fn(arg)
    }

    const requestOptions = {
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method,
      headers: {
        'accept-encoding': 'identity',
        ...(payload ? { 'content-length': payload.length } : {}),
        ...headers
      },
      lookup: pinnedLookup(rows)
    }

    let request
    try {
      request = lib.request(requestOptions, (response) => {
        const declared = Number(response.headers['content-length'] || 0)
        if (maxBytes && declared > maxBytes) {
          // 先落定、再 destroy：destroy 会同步触发 aborted/error，
          // 顺序反了的话，真正的「超限」会被「连接被中断」盖掉。
          finish(reject, new TransferLimitError(`响应声明的体积超过上限（${declared} > ${maxBytes} 字节）`))
          response.destroy()
          return
        }

        const chunks = []
        let total = 0
        response.on('data', (chunk) => {
          total += chunk.length
          if (maxBytes && total > maxBytes) {
            finish(reject, new TransferLimitError(`响应超过体积上限（已读 ${total} > ${maxBytes} 字节）`))
            response.destroy()
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => finish(resolve, {
          status: response.statusCode || 0,
          headers: response.headers,
          buffer: Buffer.concat(chunks)
        }))
        response.on('error', (error) => finish(reject, error))
        response.on('aborted', () => finish(reject, new Error('连接被对端中断')))
      })
    } catch (error) {
      finish(reject, error)
      return
    }

    // 整条请求的截止时间：不只是 socket 空闲超时，慢慢滴流也一样会被掐掉
    timer = setTimeout(() => {
      finish(reject, new TransferLimitError(`请求超时（${timeoutMs}ms）`))
      request.destroy()
    }, timeoutMs)
    timer.unref?.()

    request.on('error', (error) => finish(reject, error))
    if (payload) request.write(payload)
    request.end()
  })
}

/**
 * 发请求（带审核、可选跳转跟随、体积与超时上限）。
 *
 * 跳转默认不允许：API 的 POST 一旦被 307/308 转走，正文和认证头就跟着走了。
 * 需要跳转的调用方显式给 maxRedirects，并且每一跳都会重新审核。
 */
export async function request(rawUrl, options = {}) {
  const {
    method = 'GET',
    maxRedirects = 0,
    allowPrivate = false,
    allowLoopback = false,
    allowHosts = [],
    requireHttps = false,
    maxBytes = 8 * 1024 * 1024,
    timeoutMs = 15000,
    headers = {},
    body = null
  } = options

  let url
  try {
    url = new URL(String(rawUrl ?? ''))
  } catch {
    throw new BlockedTargetError('目标地址不是合法 URL')
  }

  let currentHeaders = { ...headers }
  let currentBody = body
  let currentMethod = method

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BlockedTargetError(`只支持 http/https 地址，收到的是 ${url.protocol}`)
    }
    if (requireHttps && url.protocol !== 'https:') {
      throw new BlockedTargetError('出于安全要求，该地址必须使用 HTTPS')
    }
    if (url.username || url.password) {
      throw new BlockedTargetError('地址里不允许携带用户名或密码')
    }
    if (!url.hostname) throw new BlockedTargetError('目标地址缺少主机名')

    const rows = await resolveAllowed(url.hostname, {
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      allowPrivate,
      allowLoopback,
      allowHosts
    })

    const response = await requestOnce(url, rows, {
      method: currentMethod,
      headers: currentHeaders,
      body: currentBody,
      timeoutMs,
      maxBytes
    })

    const location = response.headers.location
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop >= maxRedirects) {
        throw new BlockedTargetError(`目标返回了跳转（HTTP ${response.status}），出于安全没有跟随`)
      }
      let next
      try {
        next = new URL(location, url)
      } catch {
        throw new BlockedTargetError('目标返回了无法解析的跳转地址')
      }
      const sameOrigin = next.origin === url.origin
      if (!sameOrigin) {
        // 带正文（POST）的跳转一旦跨源，正文和凭据就交给了另一个服务端。
        // API 请求在调用侧已经禁止跳转，这里是第二道：任何带 body 的跨源跳转直接拒绝。
        if (currentBody !== null || currentMethod !== 'GET') {
          throw new BlockedTargetError('带着请求体的跳转指向了其他源，已拒绝')
        }
        // 纯 GET 的跨源跳转（图片 CDN 很常见）可以跟，但不能带任何认证信息
        for (const name of Object.keys(currentHeaders)) {
          if (/^(authorization|x-api-key|cookie|proxy-authorization)$/i.test(name)) delete currentHeaders[name]
        }
      }
      if (response.status === 303) {
        currentMethod = 'GET'
        currentBody = null
      }
      url = next
      continue
    }

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      headers: response.headers,
      buffer: response.buffer,
      contentType: String(response.headers['content-type'] || ''),
      url
    }
  }

  throw new BlockedTargetError('跳转次数过多')
}

export default { request, assertUrlAllowed, resolveAllowed, resolveHost, classifyAddress, isPublicAddress, redactUrl, BlockedTargetError, TransferLimitError }
