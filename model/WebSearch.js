/** Tavily 搜索适配器。搜索查询和结果均视为不可信数据。 */
import { postJson } from './http.js'

export async function searchTavily(query, { apiKey, maxResults = 5, endpoint = 'https://api.tavily.com/search', post = postJson } = {}) {
  const text = String(query ?? '').trim()
  if (!text || text.length > 400) throw new Error('搜索词为空或过长')
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('未配置联网搜索 Key')
  let target
  try { target = new URL(endpoint) } catch { throw new Error('搜索接口地址无效') }
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash) throw new Error('搜索接口必须使用不含凭据和查询参数的 HTTPS 地址')
  const count = Math.max(1, Math.min(10, Math.floor(Number(maxResults) || 5)))
  const result = await post(target.href, {
    authorization: `Bearer ${apiKey.trim()}`
  }, { query: text, search_depth: 'basic', max_results: count, include_raw_content: false }, 15000, {
    requireHttps: true, allowPrivate: false, allowLoopback: false, maxBytes: 1024 * 1024
  })
  if (!result.ok) throw new Error(`搜索服务请求失败（HTTP ${result.status}）`)
  if (!Array.isArray(result.data?.results)) throw new Error('搜索服务返回格式无效')
  return result.data.results.slice(0, count).map(row => ({
    title: String(row?.title || '').slice(0, 300),
    url: /^https?:\/\//i.test(String(row?.url || '')) ? String(row.url).slice(0, 2048) : '',
    content: String(row?.content || '').slice(0, 1800)
  }))
}
