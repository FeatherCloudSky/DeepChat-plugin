/**
 * HTTP 客户端。
 *
 * Miao-Yunzai 3.1.3 声明的最低环境是 Node.js > 16.14，而全局 fetch
 * 要到 Node 18 才默认可用。所以这里做一层兜底：
 *   有 fetch  -> 用 fetch
 *   没有      -> 退回 node:http / node:https
 * 这样插件在 16.14 以上的所有版本都能跑，不会因为 fetch is not defined 崩掉。
 *
 * 下载还带 maxBytes 上限：content-length 声明的和实际读到的都会检查，
 * 服务器不给 content-length 也不会被无限流灌爆内存。
 */
import http from 'node:http'
import https from 'node:https'

export const hasFetch = typeof globalThis.fetch === 'function'

function toResult(status, text) {
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }
  return { ok: status >= 200 && status < 300, status, data, text }
}

async function postWithFetch(url, headers, payload, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: payload,
      signal: controller.signal
    })
    return toResult(response.status, await response.text())
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 无 fetch 时的兜底实现（Node 16）。导出出来是为了能被测试直接覆盖。
 * payload 既接受已序列化的字符串，也接受普通对象。
 */
export function postWithNode(url, headers, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload)

    let target
    try {
      target = new URL(url)
    } catch {
      reject(new Error(`API 地址不是合法 URL：${url}`))
      return
    }

    const lib = target.protocol === 'http:' ? http : https
    const request = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: { ...headers, 'content-length': Buffer.byteLength(body) }
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => { text += chunk })
        response.on('end', () => resolve(toResult(response.statusCode, text)))
        response.on('error', reject)
      }
    )

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`请求超时（${timeoutMs}ms）`))
    })
    request.on('error', reject)
    request.write(body)
    request.end()
  })
}

/** POST JSON，返回 { ok, status, data, text } */
export function postJson(url, headers, body, timeoutMs) {
  const payload = JSON.stringify(body)
  return hasFetch
    ? postWithFetch(url, headers, payload, timeoutMs)
    : postWithNode(url, headers, payload, timeoutMs)
}

async function getBufferWithFetch(url, timeoutMs, maxBytes) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    const declared = Number(response.headers.get('content-length') || 0)

    if (maxBytes && declared > maxBytes) {
      controller.abort()
      throw new Error(`内容超过大小上限（声明 ${declared} 字节 > 上限 ${maxBytes}）`)
    }

    const contentType = response.headers.get('content-type') || ''

    if (!response.body || typeof response.body.getReader !== 'function') {
      const buffer = Buffer.from(await response.arrayBuffer())
      if (maxBytes && buffer.length > maxBytes) {
        throw new Error(`内容超过大小上限（${buffer.length} 字节 > 上限 ${maxBytes}）`)
      }
      return { ok: response.ok, status: response.status, buffer, contentType }
    }

    // 流式读取：即使对方不给 content-length，也不会把内存吃光
    const reader = response.body.getReader()
    const chunks = []
    let total = 0

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (maxBytes && total > maxBytes) {
        try { await reader.cancel() } catch { }
        throw new Error(`内容超过大小上限（已读 ${total} 字节 > 上限 ${maxBytes}）`)
      }
      chunks.push(Buffer.from(value))
    }

    return {
      ok: response.ok,
      status: response.status,
      buffer: Buffer.concat(chunks),
      contentType
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 无 fetch 时的下载实现，同样带大小上限 */
export function getBufferWithNode(url, timeoutMs, maxBytes) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch {
      reject(new Error(`图片地址不是合法 URL：${url}`))
      return
    }

    const lib = target.protocol === 'http:' ? http : https
    const request = lib.get(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: `${target.pathname}${target.search}`
      },
      (response) => {
        let settled = false
        const done = (fn, arg) => {
          if (settled) return
          settled = true
          fn(arg)
        }

        const declared = Number(response.headers['content-length'] || 0)
        if (maxBytes && declared > maxBytes) {
          response.destroy()
          done(reject, new Error(`内容超过大小上限（声明 ${declared} 字节 > 上限 ${maxBytes}）`))
          return
        }

        const contentType = response.headers['content-type'] || ''
        const chunks = []
        let total = 0

        response.on('data', (chunk) => {
          total += chunk.length
          if (maxBytes && total > maxBytes) {
            response.destroy()
            done(reject, new Error(`内容超过大小上限（已读 ${total} 字节 > 上限 ${maxBytes}）`))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => done(resolve, {
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          buffer: Buffer.concat(chunks),
          contentType
        }))
        response.on('error', (error) => done(reject, error))
      }
    )

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`下载超时（${timeoutMs}ms）`))
    })
    request.on('error', reject)
  })
}

/**
 * GET 并返回 Buffer（用于把图片转成 base64）
 * @param {number} [maxBytes] 超过就抛错，防止超大文件把内存吃满
 */
export function getBuffer(url, timeoutMs, maxBytes) {
  return hasFetch
    ? getBufferWithFetch(url, timeoutMs, maxBytes)
    : getBufferWithNode(url, timeoutMs, maxBytes)
}

/** 传输层描述，供 #chat状态 显示，便于排查「为什么这台上不了网」 */
export function transportName() {
  return hasFetch ? 'fetch' : 'node:http'
}
