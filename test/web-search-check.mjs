import assert from 'node:assert/strict'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { runIsolated } from './isolated-workspace.mjs'
runIsolated(fileURLToPath(import.meta.url))
globalThis.logger = Object.fromEntries(['info', 'warn', 'error', 'debug', 'mark'].map(k => [k, () => {}]))
const { default: Cfg } = await import('../model/Cfg.js')
const { default: Provider } = await import('../model/Provider.js')
const { searchTavily } = await import('../model/WebSearch.js')
let seen
const results = await searchTavily('查询', { apiKey: 'FAKE', maxResults: 2, post: async (...args) => {
  seen = args
  return { ok: true, data: { results: [{ title: '标题', url: 'https://example.org', content: '资料' }] } }
} })
assert.equal(seen[0], 'https://api.tavily.com/search')
assert.equal(seen[4].requireHttps, true)
assert.equal(results[0].title, '标题')
const requests = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    const parsed = JSON.parse(body); requests.push(parsed)
    res.setHeader('content-type', 'application/json')
    if (parsed.model === 'anth-test') {
      if (requests.length === 1) res.end(JSON.stringify({ content: [{ type: 'tool_use', id: 'tool1', name: 'web_search', input: { query: '测试' } }] }))
      else res.end(JSON.stringify({ content: [{ type: 'text', text: '无法搜索' }] }))
    } else if (parsed.tools?.[0]?.type === 'web_search') res.end(JSON.stringify({ choices: [{ message: { content: 'MiMo 联网答案' } }] }))
    else if (requests.length === 1) res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call1', type: 'function', function: { name: 'web_search', arguments: '{"query":"测试"}' } }] } }] }))
    else res.end(JSON.stringify({ choices: [{ message: { content: '搜索失败，无法确认实时信息。' } }] }))
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  Cfg.setMany({ apiUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'FAKE_MODEL', model: 'fake', webSearchEnabled: true, webSearchMode: 'tavily', webSearchApiKey: '', webSearchMaxCalls: 1 })
  const answer = await Provider.chat({ messages: [{ role: 'user', content: '查询' }] })
  assert.equal(answer, '搜索失败，无法确认实时信息。')
  assert.equal(requests.length, 2)
  assert.equal(requests[0].tools[0].function.name, 'web_search')
  assert.equal(requests[1].messages.at(-1).role, 'tool')
  assert.match(requests[1].messages.at(-1).content, /未配置联网搜索 Key/)
  assert.equal(requests[1].tool_choice, 'none')
  requests.length = 0
  Cfg.setMany({ webSearchMode: 'mimo', webSearchForce: true })
  assert.equal(await Provider.chat({ messages: [{ role: 'user', content: '查询' }] }), 'MiMo 联网答案')
  assert.equal(requests[0].tools[0].type, 'web_search')
  assert.equal(requests[0].tools[0].force_search, true)
  assert.equal(requests[0].tools[0].max_keyword, 1)
  Cfg.set('useAnthropic', true)
  let failure
  assert.equal(await Provider.chat({ messages: [{ role: 'user', content: '查询' }], onError: error => { failure = error } }), null)
  assert.match(failure.message, /仅支持 OpenAI/)
  requests.length = 0
  Cfg.setMany({ webSearchMode: 'tavily', model: 'anth-test' })
  assert.equal(await Provider.chat({ messages: [{ role: 'user', content: '查询' }] }), '无法搜索')
  assert.equal(requests[0].tools[0].name, 'web_search')
  assert.equal(requests[1].messages.at(-1).content[0].type, 'tool_result')
  assert.match(requests[1].messages.at(-1).content[0].content, /未配置联网搜索 Key/)
  console.log('联网工具基本检查通过')
} finally {
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
}
process.exit(0)
