/**
 * HTTP 客户端。
 *
 * 所有出站请求都走 model/net.js：DNS 解析结果先审核、再钉住连接地址，
 * 跳转由我们自己处理（默认不允许），响应有字节上限和整条请求的截止时间。
 * 这样同一套规则既能挡住「图片地址指向内网」的 SSRF，
 * 也能挡住「API 被 307 转到别的域、把正文和 Key 一起带走」。
 *
 * 这里保留 fetch 时代的导出名（postWithNode / getBufferWithNode / transportName），
 * 方便老调用方与测试继续用；实现已经统一成 node:http，不再有两条行为不同的链路。
 */
import { request, BlockedTargetError, TransferLimitError } from './net.js'

const DEFAULT_MAX_RESPONSE = 8 * 1024 * 1024

/** 兼容旧代码：是否运行在带 fetch 的 Node 上。请求本身不再依赖它。 */
export const hasFetch = typeof globalThis.fetch === 'function'

export function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0
  const seconds = Number(value)
  const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now
  return Number.isFinite(wait) ? Math.max(0, wait) : 0
}

function toResult(status, buffer, retryAfter) {
  const text = buffer ? buffer.toString('utf8') : ''
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }
  return { ok: status >= 200 && status < 300, status, data, text, retryAfterMs: retryAfterMs(retryAfter) }
}

/**
 * POST JSON。
 *
 * 默认**不跟随跳转**：把认证头和一个完整的请求体交给下一跳，
 * 等于让服务端决定「这些凭据该发给谁」。
 *
 * @param {object} [policy] allowPrivate / allowLoopback / allowHosts / requireHttps / maxBytes
 */
export async function postJson(url, headers, body, timeoutMs, policy = {}) {
  const result = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    timeoutMs,
    maxBytes: policy.maxBytes ?? DEFAULT_MAX_RESPONSE,
    maxRedirects: 0,
    requireHttps: Boolean(policy.requireHttps),
    allowPrivate: Boolean(policy.allowPrivate),
    allowLoopback: Boolean(policy.allowLoopback),
    allowHosts: policy.allowHosts || [],
    onBlockedResponse: typeof policy.onBlockedResponse === 'function'
      ? response => policy.onBlockedResponse(toResult(response.status, response.buffer, response.headers['retry-after']))
      : undefined
  })
  return toResult(result.status, result.buffer, result.headers['retry-after'])
}

/** Node 兜底时代的导出名，现在走同一套实现（允许本机/内网，给测试与本地网关用） */
export function postWithNode(url, headers, payload, timeoutMs) {
  return postJson(url, headers, typeof payload === 'string' ? JSON.parse(payload) : payload, timeoutMs, {
    allowPrivate: true,
    allowLoopback: true
  })
}

/**
 * GET 并返回 Buffer（用于把图片转成 base64）。
 * @param {number} [maxBytes] 超过就抛错，防止超大文件把内存吃满
 * @param {object} [policy] allowPrivate / allowLoopback / allowHosts / maxRedirects
 */
export async function getBuffer(url, timeoutMs, maxBytes, policy = {}) {
  const result = await request(url, {
    method: 'GET',
    timeoutMs: timeoutMs ?? 15000,
    maxBytes: maxBytes ?? DEFAULT_MAX_RESPONSE,
    // 图片 CDN 常见 302 到另一台机器，这里允许有限跳转，但每一跳都会重新审核
    maxRedirects: policy.maxRedirects ?? 3,
    requireHttps: Boolean(policy.requireHttps),
    allowPrivate: Boolean(policy.allowPrivate),
    allowLoopback: Boolean(policy.allowLoopback),
    allowHosts: policy.allowHosts || []
  })
  return {
    ok: result.ok,
    status: result.status,
    buffer: result.buffer,
    contentType: result.contentType
  }
}

/** 下载的兜底导出名：允许本机/内网，给适配器自己提供的资源用 */
export function getBufferWithNode(url, timeoutMs, maxBytes) {
  return getBuffer(url, timeoutMs, maxBytes, { allowPrivate: true, allowLoopback: true })
}

/** 传输层描述，供 #chat状态 显示，便于排查「为什么这台上不了网」 */
export function transportName() {
  return 'node:http（地址钉扎）'
}

export { BlockedTargetError, TransferLimitError }

export default { postJson, getBuffer, transportName, hasFetch, retryAfterMs }
