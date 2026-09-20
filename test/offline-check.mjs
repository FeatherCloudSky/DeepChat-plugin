/**
 * DeepChat-plugin 离线验证台。
 * 模拟 Yunzai 注入的全局量（plugin / logger / redis），
 * 然后在真实文件上跑协议转换、配置解析、策略判定和拆条逻辑。
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 插件根目录 = 本文件的上一级，因此在任何工作目录下运行都能定位到自己
const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const url = (rel) => pathToFileURL(path.join(pluginDir, rel)).href

// ---- 模拟 Yunzai 全局 ----
const logs = []
globalThis.logger = {
  info: (m) => logs.push(['info', String(m)]),
  warn: (m) => logs.push(['warn', String(m)]),
  error: (m) => logs.push(['error', String(m)]),
  debug: () => {},
  mark: () => {},
  red: (s) => s
}
globalThis.plugin = class {
  constructor(cfg) { Object.assign(this, cfg) }
  reply(msg) {
    const target = this.e || this
    target.__replied = (target.__replied || []).concat(String(msg))
    return Promise.resolve({ message_id: 1 })
  }
}
const redisStore = new Map()
globalThis.redis = {
  async get(k) { return redisStore.has(k) ? redisStore.get(k) : null },
  async set(k, v) { redisStore.set(k, v); return 'OK' },
  async del(k) { const keys = Array.isArray(k) ? k : [k]; keys.forEach((x) => redisStore.delete(x)); return keys.length },
  async keys(pattern) {
    const prefix = pattern.replace(/\*$/, '')
    return [...redisStore.keys()].filter((k) => k.startsWith(prefix))
  }
}

let pass = 0
let fail = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}\n        期望: ${JSON.stringify(expected)}\n        实际: ${JSON.stringify(actual)}`) }
}
function checkTrue(name, value) {
  check(name, Boolean(value), true)
}

// ============================================================ 1. 拆条
console.log('\n=== 1. splitReply 拆条 ===')
const { splitReply, parseIdList, pickApiKey, getByPath, deepMerge, isPublicHttpUrl } =
  await import(url('model/utils.js'))

check('句号拆条且保留标点', splitReply('你好。再见。'), ['你好。', '再见。'])
check('问号拆条', splitReply('在吗？有事吗？'), ['在吗？', '有事吗？'])
check('中英问号混用', splitReply('a？b?c。'), ['a？', 'b?', 'c。'])
check('连续问号不断开', splitReply('真的吗？？'), ['真的吗？？'])
check('感叹号也拆', splitReply('好！行！'), ['好！', '行！'])
check('换行拆条', splitReply('第一行\n第二行'), ['第一行', '第二行'])
check('<EMPTY> 完全不发', splitReply('<EMPTY>'), [])
check('单句不拆', splitReply('只有一句'), ['只有一句'])
check('段数超限则整段', splitReply('一。二。三。四。五。六。', { maxSegments: 5 }), ['一。二。三。四。五。六。'])
check('超长则整段', splitReply('一。二。三。', { maxLength: 5 }), ['一。二。三。'])
check('非字符串返回空数组', splitReply(null), [])

console.log('\n=== 2. 工具函数 ===')
check('parseIdList 混合分隔符', parseIdList('123, 456，789;101'), ['123', '456', '789', '101'])
check('parseIdList 数组', parseIdList([123, '456']), ['123', '456'])
checkTrue('公网地址判定：正常域名', isPublicHttpUrl('https://cdn.example.com/a.jpg'))
checkTrue('公网地址判定：公网 IP', isPublicHttpUrl('http://8.8.8.8/a.jpg'))
check('公网地址判定：localhost', isPublicHttpUrl('http://localhost/a.jpg'), false)
check('公网地址判定：127.0.0.1', isPublicHttpUrl('http://127.0.0.1:8080/a.jpg'), false)
check('公网地址判定：内网 10.x', isPublicHttpUrl('http://10.0.0.5/a.jpg'), false)
check('公网地址判定：内网 192.168.x', isPublicHttpUrl('http://192.168.31.1/a.jpg'), false)
check('公网地址判定：内网 172.16-31', isPublicHttpUrl('http://172.20.0.1/a.jpg'), false)
check('公网地址判定：链路本地 169.254', isPublicHttpUrl('http://169.254.1.1/a.jpg'), false)
check('公网地址判定：IPv6 环回', isPublicHttpUrl('http://[::1]/a.jpg'), false)
check('公网地址判定：file 协议', isPublicHttpUrl('file:///C:/a.jpg'), false)
check('公网地址判定：非法字符串', isPublicHttpUrl('not a url'), false)
check('公网地址判定：空值', isPublicHttpUrl(''), false)
check('公网地址判定：172.32 属于公网段', isPublicHttpUrl('http://172.32.0.1/a.jpg'), true)
check('pickApiKey 处理中文逗号', pickApiKey('a，b，c').length, 1)
check('pickApiKey 多分隔符', [...new Set('a，b;c\nd'.split(/[，；;\n]/).map((s) => s.trim()))], ['a', 'b', 'c', 'd'])
check('getByPath 深层取值', getByPath({ a: { b: { c: 7 } } }, 'a.b.c', 0), 7)
check('getByPath 缺失用默认值', getByPath({ a: {} }, 'a.b.c', 'def'), 'def')
check('getByPath 空字符串不触发默认值', getByPath({ a: '' }, 'a', 'def'), '')
check('deepMerge 深合并', deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 9 } }), { a: { x: 1, y: 9 } })

// ============================================================ 3. 配置
console.log('\n=== 3. Cfg 配置层 ===')
const CfgMod = await import(url('model/Cfg.js'))
const Cfg = CfgMod.default

check('默认不使用 Anthropic 协议', Cfg.getBool('useAnthropic', false), false)
check('getNumber 裁剪上限', Cfg.getNumber('maxSplitSegments', 5, 1, 3), 3)
check('getBool 默认值', Cfg.getBool('enableAt', false), true)
check('getIdList 默认空数组', Cfg.getIdList('disabledGroups'), [])
check('visionFor 未声明时用 defaultVision', Cfg.visionFor('some-model'), false)

Cfg.set('modelVision', [
  { key: 'gpt-4o', vision: true },
  { key: '*', vision: false }
])
check('visionFor 精确匹配', Cfg.visionFor('gpt-4o'), true)
check('visionFor 落到通配项', Cfg.visionFor('deepseek-chat'), false)
Cfg.set('modelVision', [{ key: 'DeepSeek-Flash', vision: true }])
check('visionFor 忽略大小写', Cfg.visionFor('deepseek-flash'), true)
check('visionFor 大写查询也命中', Cfg.visionFor('DEEPSEEK-FLASH'), true)
Cfg.set('modelVision', [])
Cfg.set('defaultVision', true)
check('visionFor 回落到 defaultVision', Cfg.visionFor('any'), true)
Cfg.set('defaultVision', false)

// ============================================================ 4. 策略
console.log('\n=== 4. Policy 策略判定 ===')
const Policy = (await import(url('model/Policy.js'))).default
const ChatState = (await import(url('model/ChatState.js'))).default

const groupEvent = { isGroup: true, group_id: 123456, user_id: 10001, self_id: 999 }
const privateEvent = { isGroup: false, user_id: 10001, self_id: 999 }

checkTrue('默认启用：群聊', Policy.resolveEnabled(groupEvent))
checkTrue('默认启用：私聊', Policy.resolveEnabled(privateEvent))

ChatState.setOverride(groupEvent, false)
check('会话级关闭生效', Policy.resolveEnabled(groupEvent), false)
ChatState.clearOverride(groupEvent)
checkTrue('清除会话设置后回到默认', Policy.resolveEnabled(groupEvent))

Cfg.set('disabledGroups', [123456])
check('禁用列表生效', Policy.resolveEnabled(groupEvent), false)
Cfg.set('disabledGroups', [])
Cfg.set('enabledGroups', [123456])
check('启用列表优先于默认关闭', (Cfg.set('enableByDefault', false), Policy.resolveEnabled(groupEvent)), true)
Cfg.set('enabledGroups', [])
Cfg.set('enableByDefault', true)

checkTrue('伪人触发：默认允许', Policy.shouldPseudoTrigger(groupEvent))
Cfg.set('pseudoBlacklistUsers', [10001])
check('伪人用户黑名单生效', Policy.shouldPseudoTrigger(groupEvent), false)
Cfg.set('pseudoBlacklistUsers', [])

// ============================================================ 4.1 名字匹配
console.log('\n=== 4.1 AI 名称匹配：默认按关键词包含 ===')
check('用户举的原例', Policy.matchAiName('不知道达达利亚圣遗物带什么好', '达达利亚'), true)
check('名字在句首', Policy.matchAiName('达达利亚在吗', '达达利亚'), true)
check('名字在句尾', Policy.matchAiName('刚抽到达达利亚', '达达利亚'), true)
check('名字在中间', Policy.matchAiName('我达达利亚今天', '达达利亚'), true)
check('完全没提到', Policy.matchAiName('今天天气不错', '达达利亚'), false)
check('空名字不命中', Policy.matchAiName('随便说点什么', ''), false)
check('空消息不命中', Policy.matchAiName('', '达达利亚'), false)
check('带符号的名字按字面匹配', Policy.matchAiName('我在学C++', 'C++'), true)
check('默认不把点号当正则', Policy.matchAiName('达达利亚X', '达达利亚.'), false)

console.log('\n=== 4.2 AI 名称匹配：可选的正则模式 ===')
check('正则模式下点号生效', Policy.matchAiName('达达利亚X', '达达利亚.', true), true)
check('正则多选一', Policy.matchAiName('公子来了', '达达利亚|公子', true), true)
check('正则没命中', Policy.matchAiName('今天天气不错', '达达利亚|公子', true), false)
check('正则写错时退回关键词匹配', Policy.matchAiName('名字(未闭合', '名字(', true), true)
check('正则模式仍然按整串搜索', Policy.matchAiName('不知道达达利亚圣遗物带什么好', '达达利亚', true), true)

// ============================================================ 4.3 聊天记录准入
console.log('\n=== 4.3 聊天记录准入：谁可以用 #记录 ===')
const recGroup = (id) => ({ isGroup: true, group_id: id, user_id: 10001, self_id: 999 })
const recPrivate = (id) => ({ isGroup: false, user_id: id, self_id: 999 })

const resetRecordGate = () => {
  Cfg.set('masterQQ', '')
  Cfg.set('adminQQ', [])
  Cfg.set('allowMemberRecord', false)
  Cfg.set('memberRecordAllowGroups', [])
  Cfg.set('memberRecordDenyGroups', [])
}
resetRecordGate()

check('空事件直接拒掉', Policy.canUseRecord(null), false)
check('默认关：普通成员在群里不能记录', Policy.canUseRecord(recGroup(123456)), false)
check('默认关：普通成员的私聊也不能', Policy.canUseRecord(recPrivate(10001)), false)

Cfg.set('allowMemberRecord', true)
check('总开关打开后群聊放行', Policy.canUseRecord(recGroup(123456)), true)
check('总开关打开后私聊也放行', Policy.canUseRecord(recPrivate(10001)), true)

Cfg.set('allowMemberRecord', false)
Cfg.set('memberRecordAllowGroups', [123456])
check('允许列表里的群，总开关关着也放行', Policy.canUseRecord(recGroup(123456)), true)
check('允许列表外的群仍然不能用', Policy.canUseRecord(recGroup(654321)), false)
check('群列表不作用于私聊（哪怕 QQ 号碰巧相同）', Policy.canUseRecord(recPrivate(123456)), false)

Cfg.set('allowMemberRecord', true)
Cfg.set('memberRecordDenyGroups', [123456])
check('禁止列表优先级最高：压过总开关', Policy.canUseRecord(recGroup(123456)), false)
check('禁止列表压过允许列表', (Cfg.set('memberRecordAllowGroups', [123456]), Policy.canUseRecord(recGroup(123456))), false)
check('禁止列表只作用于自己那几个群', Policy.canUseRecord(recGroup(654321)), true)

Cfg.set('masterQQ', '10001')
check('主人恒可用（即使在禁止列表里）', Policy.canUseRecord(recGroup(123456)), true)
Cfg.set('masterQQ', '')
Cfg.set('adminQQ', ['20001'])
check('管理员在禁止列表里的群也恒可用', Policy.canUseRecord({ isGroup: true, group_id: 123456, user_id: 20001 }), true)
check('管理员私聊恒可用', Policy.canUseRecord({ isGroup: false, user_id: 20001 }), true)
resetRecordGate()

// ============================================================ 5. 协议适配
console.log('\n=== 5. Provider 协议适配 ===')
const Provider = (await import(url('model/Provider.js'))).default

check('OpenAI 端点拼接', Provider.buildUrl('openai', 'https://api.deepseek.com/v1'),
  'https://api.deepseek.com/v1/chat/completions')
check('Anthropic 端点拼接', Provider.buildUrl('anthropic', 'https://api.anthropic.com/v1'),
  'https://api.anthropic.com/v1/messages')
check('端点容错：地址已含端点就不重复拼',
  Provider.buildUrl('openai', 'https://api.deepseek.com/v1/chat/completions'),
  'https://api.deepseek.com/v1/chat/completions')
check('端点容错：Anthropic 地址已含端点',
  Provider.buildUrl('anthropic', 'https://x/v1/messages'), 'https://x/v1/messages')
check('端点容错：协议选反了也原样使用（同时会告警）',
  Provider.buildUrl('openai', 'https://x/v1/messages'), 'https://x/v1/messages')

const openaiBody = Provider.buildRequestBody('openai', {
  model: 'gpt-4o',
  messages: [{ role: 'system', content: 'S' }, { role: 'user', content: '你好' }],
  temperature: 1,
  maxTokens: 256
})
check('OpenAI：保留 system 角色', openaiBody.messages[0], { role: 'system', content: 'S' })
check('OpenAI：max_tokens 字段名', openaiBody.max_tokens, 256)
check('OpenAI：stream 关闭', openaiBody.stream, false)

const anthropicBody = Provider.buildRequestBody('anthropic', {
  model: 'claude-3-5-sonnet-latest',
  messages: [
    { role: 'system', content: '人设' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '在' },
    { role: 'assistant', content: '的' },
    { role: 'user', content: '继续' }
  ],
  temperature: 0.7,
  maxTokens: 128
})
check('Anthropic：system 抽到顶层', anthropicBody.system, '人设')
check('Anthropic：messages 无 system 角色', anthropicBody.messages.some((m) => m.role === 'system'), false)
check('Anthropic：连续同角色已合并', anthropicBody.messages.length, 3)
check('Anthropic：合并内容', anthropicBody.messages[1].content, '在\n的')
check('Anthropic：max_tokens 必填', anthropicBody.max_tokens, 128)

const leadingAssistant = Provider.buildRequestBody('anthropic', {
  model: 'm',
  messages: [{ role: 'assistant', content: '我是开场白' }, { role: 'user', content: '你好' }],
  temperature: 1,
  maxTokens: 32
})
check('Anthropic：以 user 开头', leadingAssistant.messages[0].role, 'user')

// 图片：URL 与 base64 两条路径
const visionUrl = Provider.buildRequestBody('openai', {
  model: 'gpt-4o',
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: '这是什么' },
      { type: 'image', url: 'https://example.com/a.png' }
    ]
  }],
  temperature: 1,
  maxTokens: 64
})
check('OpenAI 图片：image_url 结构', visionUrl.messages[0].content[1],
  { type: 'image_url', image_url: { url: 'https://example.com/a.png' } })

// 图片细节级别（image_url.detail）
const imgOnly = (extra = {}) => Provider.buildRequestBody('openai', {
  model: 'm',
  messages: [{ role: 'user', content: [{ type: 'image', url: 'https://x/a.png' }] }],
  temperature: 1,
  maxTokens: 8,
  ...extra
})
check('细节级别：未配置时不发送该字段', imgOnly().messages[0].content[0].image_url.detail, undefined)
check('细节级别：low 会被带上', imgOnly({ imageDetail: 'low' }).messages[0].content[0].image_url.detail, 'low')
check('细节级别：original 会被带上', imgOnly({ imageDetail: 'original' }).messages[0].content[0].image_url.detail, 'original')
check('细节级别：归一化大小写', Provider.normalizeImageDetail('LOW'), 'low')
check('细节级别：两侧空格', Provider.normalizeImageDetail('  high  '), 'high')
check('细节级别：未知值被忽略', Provider.normalizeImageDetail('ultra'), '')
check('细节级别：空值', Provider.normalizeImageDetail(''), '')
check('细节级别：null', Provider.normalizeImageDetail(null), '')

const anthropicDetailBody = Provider.buildRequestBody('anthropic', {
  model: 'm',
  messages: [{ role: 'user', content: [{ type: 'image', url: 'https://x/a.png' }] }],
  temperature: 1,
  maxTokens: 8,
  imageDetail: 'low'
})
checkTrue('Anthropic 请求体里不出现 detail', !JSON.stringify(anthropicDetailBody).includes('detail'))

const visionBase64 = Provider.buildRequestBody('anthropic', {
  model: 'claude-3-5-sonnet-latest',
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: '看图' },
      { type: 'image', data: 'AAAA', mediaType: 'image/png' }
    ]
  }],
  temperature: 1,
  maxTokens: 64
})
check('Anthropic 图片：base64 source', visionBase64.messages[0].content[1],
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } })

const visionUrlAnthropic = Provider.buildRequestBody('anthropic', {
  model: 'm',
  messages: [{ role: 'user', content: [{ type: 'image', url: 'https://example.com/b.jpg' }] }],
  temperature: 1,
  maxTokens: 64
})
check('Anthropic 图片：url source', visionUrlAnthropic.messages[0].content[0],
  { type: 'image', source: { type: 'url', url: 'https://example.com/b.jpg' } })

check('图片压成纯文本占位', Provider.partsToPlainText(
  [{ type: 'text', text: '你好' }, { type: 'image', url: 'x' }], '[图片]'), '你好 [图片]')

check('空文本消息被过滤', Provider.buildRequestBody('openai', {
  model: 'm', messages: [{ role: 'user', content: '   ' }], temperature: 1, maxTokens: 8
}).messages.length, 1)

// ============================================================ 5.1 HTTP 层
console.log('\n=== 5.1 HTTP 传输层 ===')
const httpMod = await import(url('model/http.js'))
check('当前环境使用 fetch', httpMod.transportName(), 'fetch')
checkTrue('导出了 Node 兜底实现', typeof httpMod.postWithNode === 'function')

{
  const http = await import('node:http')
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        echo: body,
        auth: req.headers.authorization || '',
        len: req.headers['content-length']
      }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const r = await httpMod.postWithNode(
    `http://127.0.0.1:${port}/v1/chat/completions`,
    { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
    { model: 'm', messages: [{ role: 'user', content: '你好' }] },
    5000
  )
  check('兜底实现：状态码', r.status, 200)
  check('兜底实现：ok 判定', r.ok, true)
  checkTrue('兜底实现：JSON 已解析', r.data?.ok === true)
  check('兜底实现：透传 Authorization 头', r.data?.auth, 'Bearer sk-test')
  checkTrue('兜底实现：自动补 content-length', Number(r.data?.len) > 0)
  checkTrue('兜底实现：请求体完整送达', String(r.data?.echo).includes('"role":"user"'))

  const buf = await httpMod.getBufferWithNode(`http://127.0.0.1:${port}/v1/x`, 5000)
  check('兜底实现：getBuffer 状态码', buf.status, 200)
  checkTrue('兜底实现：getBuffer 拿到内容', buf.buffer.length > 0)

  // 大小上限：不许把超大响应整个读进内存
  let limitError = ''
  try {
    await httpMod.getBuffer(`http://127.0.0.1:${port}/v1/x`, 5000, 10)
  } catch (error) {
    limitError = error.message
  }
  checkTrue('fetch 链路超过 maxBytes 会抛错', /上限/.test(limitError))

  let limitErrorNode = ''
  try {
    await httpMod.getBufferWithNode(`http://127.0.0.1:${port}/v1/x`, 5000, 10)
  } catch (error) {
    limitErrorNode = error.message
  }
  checkTrue('Node 兜底链路超过 maxBytes 也会抛错', /上限/.test(limitErrorNode))

  await new Promise((resolve) => server.close(resolve))
}

// ============================================================ 5.2 端到端
console.log('\n=== 5.2 端到端：对着假 API 真发一次请求 ===')
{
  const http = await import('node:http')
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let parsed = null
      try { parsed = JSON.parse(body) } catch { parsed = null }
      seen.push({ url: req.url, headers: req.headers, body: parsed })

      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '你好。再见。' } }] }))
      } else if (req.url === '/v1/messages') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ content: [{ type: 'text', text: '喵~' }, { type: 'text', text: '在的。' }] }))
      } else {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'not found' } }))
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  Cfg.set('apiUrl', `http://127.0.0.1:${port}/v1`)
  Cfg.set('apiKey', 'key-one,key-two')
  Cfg.set('model', 'test-model')
  Cfg.set('attemptMax', 1)

  Cfg.set('useAnthropic', false)
  const openaiAnswer = await Provider.chat({
    messages: [{ role: 'system', content: '人设' }, { role: 'user', content: '你好' }],
    temperature: 1,
    maxTokens: 64
  })
  check('端到端：OpenAI 协议返回文本', openaiAnswer, '你好。再见。')
  check('端到端：请求打到 /chat/completions', seen[seen.length - 1].url, '/v1/chat/completions')
  checkTrue('端到端：带 Bearer 头', String(seen[seen.length - 1].headers.authorization).startsWith('Bearer key-'))
  check('端到端：max_tokens 字段正确', seen[seen.length - 1].body.max_tokens, 64)
  checkTrue('端到端：system 保留在 messages 里',
    seen[seen.length - 1].body.messages.some((m) => m.role === 'system'))

  Cfg.set('useAnthropic', true)
  const anthropicAnswer = await Provider.chat({
    messages: [{ role: 'system', content: '人设' }, { role: 'user', content: '在吗' }],
    temperature: 1,
    maxTokens: 32
  })
  check('端到端：Anthropic 协议拼接多个文本块', anthropicAnswer, '喵~在的。')
  check('端到端：请求打到 /messages', seen[seen.length - 1].url, '/v1/messages')
  checkTrue('端到端：带 x-api-key 头', String(seen[seen.length - 1].headers['x-api-key']).startsWith('key-'))
  check('端到端：带 anthropic-version 头', seen[seen.length - 1].headers['anthropic-version'], '2023-06-01')
  check('端到端：system 提到顶层', seen[seen.length - 1].body.system, '人设')
  check('端到端：messages 不含 system 角色',
    seen[seen.length - 1].body.messages.some((m) => m.role === 'system'), false)

  Cfg.set('apiUrl', `http://127.0.0.1:${port}/nope`)
  const failed = await Provider.chat({ messages: [{ role: 'user', content: 'hi' }], temperature: 1, maxTokens: 8 })
  check('端到端：接口 404 时安静返回 null', failed, null)

  await new Promise((resolve) => server.close(resolve))
  Cfg.set('apiUrl', '')
  Cfg.set('apiKey', '')
  Cfg.set('model', '')
  Cfg.set('useAnthropic', false)
  Cfg.set('attemptMax', 2)
}

// ============================================================ 6. 插件类
console.log('\n=== 6. 插件类装载 ===')
const chatMod = await import(url('apps/chat.js'))
const chatInstance = new chatMod.default({})
check('chat 插件名', chatInstance.name, 'DeepChat')
checkTrue('chat 注册了 #chat 规则', chatInstance.rule.some((r) => r.reg.includes('#chat')))
checkTrue('chat 实现了 accept 拦截', typeof chatInstance.accept === 'function')

const manageMod = await import(url('apps/manage.js'))
const manageInstance = new manageMod.manage({})
checkTrue('manage 优先级低于 chat（更早匹配）', manageInstance.priority < chatInstance.priority)

const helpMod = await import(url('apps/help.js'))
const helpInstance = new helpMod.help({})
checkTrue('help 优先级最低（最先匹配）', helpInstance.priority < manageInstance.priority)

// 入口文件：loader.js 第 121 行是 `if (app.apps) app = { ...app.apps }`，
// 然后对每个值做 `new p()`，所以 apps 里必须都是可实例化的类。
// 这条契约之前没有任何测试覆盖，这里固定住。
const indexMod = await import(url('index.js'))
checkTrue('index.js 导出了 apps 对象',
  Boolean(indexMod.apps) && typeof indexMod.apps === 'object')
check('apps 收集到的插件类', Object.keys(indexMod.apps).sort(),
  ['broadcast', 'chat', 'help', 'manage', 'record', 'soup'])
checkTrue('apps 里每一项都是可实例化的类',
  Object.values(indexMod.apps).every((c) => typeof c === 'function' && c.prototype))
checkTrue('apps 里的类都能 new 出来',
  Object.values(indexMod.apps).every((c) => { try { new c(); return true } catch { return false } }))

// 命令正则必须真正命中：直接拿注册的 reg 去匹配典型输入
const matches = (instance, msg) => instance.rule.some((r) => new RegExp(r.reg).test(msg))
checkTrue('#DeepHelp 触发帮助', matches(helpInstance, '#DeepHelp'))
checkTrue('#deephelp 大小写不敏感', matches(helpInstance, '#deephelp'))
checkTrue('#DEEPHELP 全大写也可以', matches(helpInstance, '#DEEPHELP'))
checkTrue('DeepHelp 省略 # 也可以', matches(helpInstance, 'DeepHelp'))
checkTrue('#DeepChat帮助 仍作为别名保留', matches(helpInstance, '#DeepChat帮助'))
checkTrue('#Deep指令 仍作为别名保留', matches(helpInstance, '#Deep指令'))
check('不带 Deep 的 #Chat帮助 不属于本插件（避免和 Chat-plugin 抢命令）',
  matches(helpInstance, '#Chat帮助'), false)
check('普通聊天不触发帮助', matches(helpInstance, '你们好呀'), false)
checkTrue('#chat开 触发会话开关', matches(manageInstance, '#chat开'))
checkTrue('#chat关 触发会话开关', matches(manageInstance, '#chat关'))
checkTrue('#chat状态 触发会话开关', matches(manageInstance, '#chat状态'))
check('管理命令不会被对话规则抢走', matches(chatInstance, '#chat开'), false)
check('帮助命令不会被对话规则抢走', matches(chatInstance, '#chat帮助'), false)
checkTrue('#chat 加内容触发对话', matches(chatInstance, '#chat 你好'), true)

// 裸 #chat 会进入对话处理器，但应当在调用 API 之前就给出提示
const mockEvent = (over = {}) => {
  const e = {
    isGroup: true, group_id: 123456, user_id: 10001, self_id: 999,
    msg: '', message: [], sender: { nickname: '测试用户' }, __replied: [], __raw: []
  }
  e.reply = (msg) => {
    e.__raw.push(msg)
    e.__replied.push(String(msg))
    return Promise.resolve({ message_id: 1 })
  }
  return Object.assign(e, over)
}

const noArgEvent = mockEvent({ msg: '#chat' })
await chatInstance.chatCommand(noArgEvent)
check('裸 #chat 提示补充内容', /内容/.test(noArgEvent.__replied?.[0] || ''), true)

const disabledEvent = mockEvent({ msg: '#chat 你好' })
ChatState.setOverride(disabledEvent, false)
await chatInstance.chatCommand(disabledEvent)
check('已停用会话里 #chat 给出开启提示', /#chat开/.test(disabledEvent.__replied?.[0] || ''), true)
ChatState.clearOverride(disabledEvent)

// 帮助内容里必须出现主命令本身
const helpEvent = mockEvent({ msg: '#DeepHelp' })
helpInstance.e = helpEvent
await helpInstance.help(helpEvent)
check('帮助内容包含 #DeepHelp', /#DeepHelp/.test(helpEvent.__replied?.[0] || ''), true)

const guobaMod = await import(url('guoba.support.js'))
const guoba = guobaMod.supportGuoba()
const tabLabels = guoba.configInfo.schemas.filter((s) => s.component === 'SOFT_GROUP_BEGIN').map((s) => s.label)
check('锅巴面板标签页', tabLabels,
  ['API 配置', '模型能力', '基本配置', '分条发送', '上下文与缓存', '启用控制',
   '权限设置', '聊天记录', '海龟汤', '群发消息', '伪人模式', '黑白名单设置', '帮助图'])
checkTrue('含逐模型图片能力字段', guoba.configInfo.schemas.some((s) => s.field === 'modelVision'))
checkTrue('含帮助背景字段', guoba.configInfo.schemas.some((s) => s.field === 'helpBg'))
checkTrue('含主人 QQ 字段', guoba.configInfo.schemas.some((s) => s.field === 'masterQQ'))

// 面板左上角那个图标：锅巴拿到的是 iconPath 指向的文件，路径必须在插件自己目录里，
// 否则换台机器 / 换个目录名就裂了
checkTrue('面板图标指向插件自带的图片',
  path.isAbsolute(guoba.pluginInfo?.iconPath || '') &&
  guoba.pluginInfo.iconPath.endsWith(path.join('resources', 'images', 'icon.png')))
{
  const iconPng = path.join(pluginDir, 'resources', 'images', 'icon.png')
  const iconSvg = path.join(pluginDir, 'resources', 'images', 'icon.svg')
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  checkTrue('图标 PNG 存在', fs.existsSync(iconPng))
  check('图标文件确实是一张 PNG',
    fs.existsSync(iconPng) && fs.readFileSync(iconPng).subarray(0, 8).equals(pngMagic), true)
  checkTrue('图标的矢量源文件也在', fs.existsSync(iconSvg))
}

// ============================================================ 6.2 权限
console.log('\n=== 6.2 权限判定 ===')
const Permission = (await import(url('model/Permission.js'))).default
const memberEvent = (id, extra = {}) => ({ user_id: id, isGroup: true, group_id: 1, ...extra })

check('上限常量', Permission.MAX_ADMINS, 5)
check('未配置主人时不误判', Permission.isMaster(memberEvent(12345)), false)
checkTrue('宿主 isMaster 仍然有效', Permission.isMaster(memberEvent(12345, { isMaster: true })))

Cfg.set('masterQQ', '10001')
check('配置的主人被识别', Permission.isMaster(memberEvent(10001)), true)
check('数字与字符串 QQ 号都能匹配', Permission.isMaster(memberEvent('10001')), true)
check('别人不是主人', Permission.isMaster(memberEvent(10002)), false)
checkTrue('配置了主人后，宿主主人仍保留权限',
  Permission.isMaster(memberEvent(99999, { isMaster: true })))

Cfg.set('adminQQ', ['20001', '20002', '20003', '20004', '20005', '20006', '20007'])
check('管理员数量被截断到 5 个', Permission.adminIds().length, 5)
check('被截断的尾巴不生效', Permission.isAdmin(memberEvent('20006')), false)
check('前 5 个里最后一个生效', Permission.isAdmin(memberEvent('20005')), true)
check('主人同时算管理员', Permission.isAdmin(memberEvent(10001)), true)
check('普通成员不是管理员', Permission.isAdmin(memberEvent(30001)), false)
check('角色标签：主人', Permission.roleLabel(memberEvent(10001)), '主人')
check('角色标签：管理员', Permission.roleLabel(memberEvent('20001')), '管理员')
check('角色标签：普通成员', Permission.roleLabel(memberEvent(30001)), '普通成员')
check('多填主人只取第一个', (Cfg.set('masterQQ', '10001,10002'), Permission.masterId()), '10001')

// 管理命令的准入
const adminEvent = mockEvent({ user_id: 20001 })
const memberEvent2 = mockEvent({ user_id: 30001 })

// ============================================================ 6.3 名称与关键词触发
console.log('\n=== 6.3 名称与关键词触发：完整走一遍 accept() ===')
const nameEvent = (text, extra = {}) => mockEvent({
  msg: text,
  message: [{ type: 'text', text }],
  atme: false,
  sender: { nickname: '群友', role: 'member' },
  ...extra
})

// 用 spy 顶掉 processChat，直接观察「走了主动还是伪人」
const calls = []
const realProcessChat = chatInstance.processChat.bind(chatInstance)
chatInstance.processChat = async (e, content, mode) => {
  calls.push({ content, mode })
  return true
}

Cfg.set('aiName', '达达利亚')
Cfg.set('enableName', true)
Cfg.set('aiNameRegex', false)
Cfg.set('aiKeywords', [])
// 关掉随机接话，只留明确呼叫，验证点名不依赖伪人概率
Cfg.set('enablePseudoHuman', false)

calls.length = 0
await chatInstance.accept(nameEvent('不知道达达利亚圣遗物带什么好'))
check('名称触发：句子中间提到也命中', calls.length, 1)
check('名称触发走主动模式', calls[0]?.mode, 'active')

calls.length = 0
await chatInstance.accept(nameEvent('今天天气不错'))
check('没提到时不触发', calls.length, 0)

// 关键回归：伪人黑名单只针对随机接话，不该让点名也失灵
Cfg.set('pseudoBlacklistGroups', [123456])
calls.length = 0
await chatInstance.accept(nameEvent('不知道达达利亚圣遗物带什么好'))
check('群在伪人黑名单里，点名依然触发', calls.length, 1)
check('且仍然是主动模式', calls[0]?.mode, 'active')
Cfg.set('pseudoBlacklistGroups', [])

Cfg.set('enableName', false)
calls.length = 0
await chatInstance.accept(nameEvent('不知道达达利亚圣遗物带什么好'))
check('关掉「名字触发回复」后不再命中', calls.length, 0)
Cfg.set('enableName', true)

Cfg.set('aiNameRegex', true)
Cfg.set('aiName', '达达利亚|公子')
calls.length = 0
await chatInstance.accept(nameEvent('公子今天心情不错'))
check('正则模式下 A|B 能命中', calls.length, 1)
Cfg.set('aiName', '达达利亚')
Cfg.set('aiNameRegex', false)

// ---- 触发关键词 ----
Cfg.set('aiKeywords', ['小助手', '机器人'])
calls.length = 0
await chatInstance.accept(nameEvent('小助手在吗'))
check('关键词命中即触发', calls.length, 1)
check('关键词也走主动模式', calls[0]?.mode, 'active')

calls.length = 0
await chatInstance.accept(nameEvent('今天天气不错'))
check('关键词没命中就不触发', calls.length, 0)

Cfg.set('aiKeywords', [])
calls.length = 0
await chatInstance.accept(nameEvent('小助手在吗'))
check('清空关键词后不再触发', calls.length, 0)

const manyKeywords = Array.from({ length: 25 }, (_, i) => `词${i + 1}`)
Cfg.set('aiKeywords', manyKeywords)
check('关键词上限 20 个', Policy.keywordList().length, 20)
check('超出部分被丢弃', Policy.keywordList().includes('词21'), false)
Cfg.set('aiKeywords', ['重复', '重复', '另一个'])
check('关键词自动去重', Policy.keywordList().length, 2)
check('命中时返回命中的那个词', Policy.matchAiKeyword('这里是另一个', ['重复', '另一个']), '另一个')
check('关键词不做正则解释（未命中返回空串）', Policy.matchAiKeyword('abc123', ['\\d+']), '')
check('关键词列表为空时不命中', Policy.matchAiKeyword('随便', []), '')
Cfg.set('aiKeywords', [])

// ---- 纯图片消息（没有文字）----
// 回归：e.msg 是空串时不能被「没有文字」这道门拦掉
calls.length = 0
await chatInstance.accept(mockEvent({
  isGroup: false, user_id: 777, msg: '',
  message: [{ type: 'image', url: 'https://example.com/a.jpg' }]
}))
check('私聊纯图片消息能触发', calls.length, 1)
check('私聊纯图片走主动模式', calls[0]?.mode, 'active')

calls.length = 0
await chatInstance.accept(mockEvent({
  isGroup: true, group_id: 123456, user_id: 777, atme: true, msg: '',
  message: [{ type: 'image', url: 'https://example.com/a.jpg' }],
  bot: { info: { nickname: '小助手' } }
}))
check('群里艾特 + 纯图片也能触发', calls.length, 1)

calls.length = 0
await chatInstance.accept(mockEvent({ isGroup: false, user_id: 777, msg: '', message: [] }))
check('既没文字也没图片时不触发', calls.length, 0)

chatInstance.processChat = realProcessChat
Cfg.set('aiName', '猫娘')
Cfg.set('enablePseudoHuman', true)

Cfg.set('masterQQ', '10001')
Cfg.set('adminQQ', ['20001'])
Cfg.set('allowMemberToggle', false)

await manageInstance.enable(memberEvent2)
check('默认：普通成员不能开关会话', /只有主人和管理员/.test(memberEvent2.__replied?.[0] || ''), true)

await manageInstance.enable(adminEvent)
check('管理员可以开关会话', /已启用/.test(adminEvent.__replied?.[0] || ''), true)
ChatState.clearOverride(adminEvent)

Cfg.set('allowMemberToggle', true)
// 用新的事件对象，避免读到上一次调用留下的回复
const memberEvent3 = mockEvent({ user_id: 30001 })
await manageInstance.enable(memberEvent3)
check('放开后普通成员也能开关', /已启用/.test(memberEvent3.__replied?.[0] || ''), true)
ChatState.clearOverride(memberEvent3)
Cfg.set('allowMemberToggle', false)

const notMaster = mockEvent({ user_id: 30001, isMaster: false })
await manageInstance.resetAll(notMaster)
check('非主人不能清空全部开关', /只有主人/.test(notMaster.__replied?.[0] || ''), true)

const realMaster = mockEvent({ user_id: 10001, isMaster: false })
await manageInstance.resetAll(realMaster)
check('主人可以清空全部开关', /已清空/.test(realMaster.__replied?.[0] || ''), true)

Cfg.set('masterQQ', '')
Cfg.set('adminQQ', [])

// ============================================================ 6.5 全链路
console.log('\n=== 6.5 全链路：一条群消息 → 真实 API → 分条回复 → 写缓存 ===')
{
  const http = await import('node:http')
  const received = []

  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      try { received.push(JSON.parse(body)) } catch { received.push(null) }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '第一句。第二句？第三句' } }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  redisStore.clear()

  // 把会拖慢测试的都关掉
  Cfg.set('apiUrl', `http://127.0.0.1:${port}/v1`)
  Cfg.set('apiKey', 'sk-e2e')
  Cfg.set('model', 'e2e-model')
  Cfg.set('attemptMax', 1)
  Cfg.set('useAnthropic', false)
  Cfg.set('aiName', '达达利亚')
  Cfg.set('enableName', true)
  Cfg.set('aiNameRegex', false)
  Cfg.set('aiKeywords', [])
  Cfg.set('enablePseudoHuman', false)
  Cfg.set('splitReply', true)
  Cfg.set('maxSplitSegments', 5)
  Cfg.set('noSplitOverLength', 500)
  Cfg.set('replyDelayPerChar', 0)
  Cfg.set('replyDelayMaxMs', 0)
  Cfg.set('historyCount', 2)
  Cfg.set('maxContextLength', 10)
  Cfg.set('cacheExpireMinutes', 60)
  Cfg.set('imageMaxCount', 0)
  Cfg.set('thinking', false)

  const makeGroupEvent = (text) => mockEvent({
    msg: text,
    message: [{ type: 'text', text }],
    group_id: 987654,
    user_id: 666,
    atme: false,
    group_name: '测试群',
    bot: { info: { nickname: '小助手' } },
    sender: { nickname: '群友', card: '群友甲', role: 'member' },
    group: {
      getChatHistory: async () => ([{
        user_id: 5,
        raw_message: '昨天聊到圣遗物',
        message: [{ type: 'text', text: '昨天聊到圣遗物' }],
        sender: { nickname: '别人', role: 'member' }
      }])
    },
    friend: { getChatHistory: async () => [] }
  })

  const first = makeGroupEvent('不知道达达利亚圣遗物带什么好')
  const handled = await chatInstance.accept(first)

  check('全链路：accept 返回已处理', handled, true)
  check('全链路：回复被按标点拆成 3 条', first.__replied, ['第一句。', '第二句？', '第三句'])
  check('全链路：只发了一次 API 请求', received.length, 1)

  const req1 = received[0]
  check('全链路：请求带上了模型名', req1?.model, 'e2e-model')
  check('全链路：请求里有 system 消息', req1?.messages?.[0]?.role, 'system')
  checkTrue('全链路：system 里写了 AI 名字', String(req1?.messages?.[0]?.content).includes('达达利亚'))
  checkTrue('全链路：system 里带了人设', String(req1?.messages?.[0]?.content).includes('人设设定'))
  checkTrue('全链路：附带了最近聊天记录',
    req1.messages.some((m) => typeof m.content === 'string' && m.content.includes('昨天聊到圣遗物')))
  checkTrue('全链路：历史消息带发送者前缀',
    req1.messages.some((m) => typeof m.content === 'string' && m.content.includes('(群员)') && m.content.includes('别人:')))
  checkTrue('全链路：本次提问带发送者前缀',
    String(req1.messages[req1.messages.length - 1].content).includes('群友甲:'))

  const cacheKey = `DeepChat-plugin:chat:group:987654`
  checkTrue('全链路：上下文已写入缓存', redisStore.has(cacheKey))
  const cached = JSON.parse(redisStore.get(cacheKey) || '[]')
  check('全链路：缓存最后一条是 AI 的回复', cached[cached.length - 1]?.content, '第一句。第二句？第三句')
  check('全链路：缓存里只有 system + 对话', cached[0].role, 'system')

  // 不满足触发条件的消息应当什么都不做
  const quiet = makeGroupEvent('今天天气不错')
  check('全链路：没点名也没关键词时不触发', await chatInstance.accept(quiet), false)
  check('全链路：不触发就不发请求', received.length, 1)
  check('全链路：不触发就不回复', quiet.__replied.length, 0)

  // 第二轮：应当复用缓存，并把上一轮的回复作为 assistant 消息带上
  const second = makeGroupEvent('达达利亚那武器呢')
  await chatInstance.accept(second)
  check('全链路：第二轮又发了一次请求', received.length, 2)
  checkTrue('全链路：第二轮带上了上一轮的回复',
    received[1].messages.some((m) => m.role === 'assistant' && String(m.content).includes('第一句')))
  checkTrue('全链路：第二轮带上了本次提问',
    String(received[1].messages[received[1].messages.length - 1].content).includes('那武器呢'))
  check('全链路：system 消息没有被重复堆叠',
    received[1].messages.filter((m) => m.role === 'system').length, 1)

  // ---- 带图片的一轮：验证图片真的被拼成多模态内容 ----
  Cfg.set('imageMaxCount', 3)
  Cfg.set('imageDownload', false)
  Cfg.set('imageDetail', 'low')
  Cfg.set('modelVision', [{ key: 'e2e-model', vision: true }])
  received.length = 0

  const imageEvent = makeGroupEvent('达达利亚 这是什么')
  imageEvent.message = [
    { type: 'text', text: '达达利亚 这是什么' },
    { type: 'image', url: 'https://example.com/card.jpg' }
  ]
  await chatInstance.accept(imageEvent)

  check('图片轮：发出了请求', received.length, 1)
  const lastContent = received[0].messages[received[0].messages.length - 1].content
  checkTrue('图片轮：用户消息变成分段数组', Array.isArray(lastContent))
  checkTrue('图片轮：保留了文字段',
    lastContent.some((p) => p.type === 'text' && String(p.text).includes('这是什么')))
  check('图片轮：图片段是 OpenAI 的 image_url 结构',
    JSON.stringify(lastContent.filter((p) => p.type === 'image_url')),
    JSON.stringify([{ type: 'image_url', image_url: { url: 'https://example.com/card.jpg', detail: 'low' } }]))
  Cfg.set('imageDetail', '')

  // 模型没开图片能力时，应当降级成 [图片] 文字，而不是把图片塞过去
  Cfg.set('modelVision', [])
  Cfg.set('defaultVision', false)
  received.length = 0
  const noVisionEvent = makeGroupEvent('达达利亚 这是什么')
  noVisionEvent.message = [
    { type: 'text', text: '达达利亚 这是什么' },
    { type: 'image', url: 'https://example.com/card.jpg' }
  ]
  await chatInstance.accept(noVisionEvent)
  const fallbackContent = received[0].messages[received[0].messages.length - 1].content
  checkTrue('未开图片能力时降级为 [图片] 文字', String(fallbackContent).includes('[图片]'))
  checkTrue('未开图片能力时不会带 image_url 段', !JSON.stringify(fallbackContent).includes('image_url'))

  // ---- 引用图片：图片在被引用的那条消息里 ----
  Cfg.set('imageMaxCount', 3)
  Cfg.set('modelVision', [{ key: 'e2e-model', vision: true }])
  received.length = 0

  const quotedEvent = mockEvent({
    isGroup: true, group_id: 987654, user_id: 666, atme: true,
    msg: '达达利亚 你认识他是谁吗',
    // 引用一张图片时，当前消息只有 reply 段，没有 image 段
    message: [
      { type: 'reply', id: 'quoted-msg-1' },
      { type: 'text', text: '达达利亚 你认识他是谁吗' }
    ],
    bot: { info: { nickname: '小助手' } },
    sender: { nickname: '群友', card: '群友甲', role: 'member' },
    group: {
      getChatHistory: async () => ([{
        message_id: 'quoted-msg-1',
        raw_message: '[图片]',
        message: [{ type: 'image', url: 'https://example.com/quoted.jpg' }],
        sender: { nickname: '群友', role: 'member' }
      }])
    },
    friend: { getChatHistory: async () => [] }
  })
  await chatInstance.accept(quotedEvent)

  check('引用图片：发出了请求', received.length, 1)
  const quotedContent = received[0].messages[received[0].messages.length - 1].content
  checkTrue('引用图片：当前消息没有 image 段时也能拿到图', Array.isArray(quotedContent))
  check('引用图片：用的是被引用消息里的那张图',
    JSON.stringify(quotedContent.filter((p) => p.type === 'image_url')),
    JSON.stringify([{ type: 'image_url', image_url: { url: 'https://example.com/quoted.jpg' } }]))

  // 引用的消息在最近记录里找不到时，不该崩，也不该塞假图片
  received.length = 0
  const lostQuoteEvent = mockEvent({
    isGroup: true, group_id: 987654, user_id: 666, atme: true,
    msg: '达达利亚 你看这个',
    message: [{ type: 'reply', id: 'not-in-history' }, { type: 'text', text: '达达利亚 你看这个' }],
    bot: { info: { nickname: '小助手' } },
    sender: { nickname: '群友', role: 'member' },
    group: { getChatHistory: async () => ([]) },
    friend: { getChatHistory: async () => [] }
  })
  await chatInstance.accept(lostQuoteEvent)
  check('引用找不到时：仍然照常回复文字', received.length, 1)
  checkTrue('引用找不到时：不会带 image_url',
    !JSON.stringify(received[0].messages[received[0].messages.length - 1].content).includes('image_url'))

  await new Promise((resolve) => server.close(resolve))
  redisStore.clear()

  Cfg.set('apiUrl', '')
  Cfg.set('apiKey', '')
  Cfg.set('model', '')
  Cfg.set('aiName', '猫娘')
  Cfg.set('enablePseudoHuman', true)
  Cfg.set('historyCount', 7)
  Cfg.set('maxContextLength', 25)
}

// ============================================================ 6.1 帮助内容
console.log('\n=== 6.1 帮助内容：markdown 解析 ===')
const HelpContent = (await import(url('model/HelpContent.js'))).default

const parsed = HelpContent.parseHelpMarkdown([
  '# 标题测试',
  '',
  '## 分组甲',
  '- `#foo` — 说明甲',
  '- #bar - 说明乙',
  '- 只有标题没有说明',
  '## 分组乙',
  '- #baz：说明丙'
].join('\n'))

check('解析文档标题', parsed.title, '标题测试')
check('解析分组数量', parsed.groups.length, 2)
check('解析分组名', parsed.groups[0].group, '分组甲')
check('去掉行内代码反引号', parsed.groups[0].list[0].title, '#foo')
check('破折号分隔符', parsed.groups[0].list[0].desc, '说明甲')
check('短横线分隔符', parsed.groups[0].list[1].desc, '说明乙')
check('没有说明的条目', parsed.groups[0].list[2], { title: '只有标题没有说明', desc: '' })
check('冒号分隔符', parsed.groups[1].list[0].desc, '说明丙')
check('分组归属正确', parsed.groups[1].list.length, 1)
check('空文档不炸', HelpContent.parseHelpMarkdown('').groups.length, 0)
check('null 不炸', HelpContent.parseHelpMarkdown(null).groups.length, 0)

const realHelp = HelpContent.loadHelp()
checkTrue('真实 help.md 解析出分组', realHelp.groups.length >= 3)
checkTrue('真实 help.md 里每个分组都有条目', realHelp.groups.every((g) => g.list.length > 0))
const plain = HelpContent.toPlainText(realHelp)
checkTrue('纯文本兜底含 #DeepHelp', plain.includes('#DeepHelp'))
checkTrue('纯文本兜底含 #chat开', plain.includes('#chat开'))

// ============================================================ 6.6 帮助出图与兜底
console.log('\n=== 6.6 帮助出图与兜底 ===')
{
  let captured = null

  const okEvent = mockEvent({})
  okEvent.runtime = {
    render: async (plugin, tplPath, data, cfg) => {
      captured = { plugin, tplPath, data, cfg }
      return 'BASE64_IMAGE_DATA'
    }
  }
  const okHelp = new helpMod.help()
  okHelp.e = okEvent
  await okHelp.help(okEvent)

  // 发图用 e.reply(渲染结果) —— TRSS 渲染器自己的发法，实测这条能出图
  check('出图成功时发的是渲染结果', okEvent.__replied[0], 'BASE64_IMAGE_DATA')
  check('传给渲染器的插件名 = 文件夹名', captured?.plugin, 'DeepChat-plugin')
  check('传给渲染器的模板相对路径', captured?.tplPath, 'help/index')
  // 关键：默认模式下渲染器即使截图失败也返回 true，
  // 所以必须用 base64 模式把图拿回来自己判断
  check('使用 base64 模式', captured?.cfg?.retType, 'base64')
  checkTrue('beforeRender 里设置了 sys.scale',
    captured?.cfg?.beforeRender({ data: {} })?.sys?.scale > 0)
  checkTrue('传给模板的数据里有分组', Array.isArray(captured?.data?.groups))
  checkTrue('传给模板的数据里有背景',
    typeof captured?.data?.bg === 'string' && captured.data.bg.length > 0)

  // 渲染器返回空 = 截图失败，此时必须退回纯文本，而不是静默什么都不回
  const emptyEvent = mockEvent({})
  emptyEvent.runtime = { render: async () => '' }
  const emptyHelp = new helpMod.help()
  emptyHelp.e = emptyEvent
  await emptyHelp.help(emptyEvent)
  checkTrue('截图返回空时退回纯文本', String(emptyEvent.__replied[0]).includes('#DeepHelp'))

  const throwEvent = mockEvent({})
  throwEvent.runtime = { render: async () => { throw new Error('boom') } }
  const throwHelp = new helpMod.help()
  throwHelp.e = throwEvent
  await throwHelp.help(throwEvent)
  checkTrue('渲染抛异常时退回纯文本', String(throwEvent.__replied[0]).includes('#DeepHelp'))

  const noneEvent = mockEvent({})
  const noneHelp = new helpMod.help()
  noneHelp.e = noneEvent
  await noneHelp.help(noneEvent)
  checkTrue('宿主没有 runtime 时退回纯文本', String(noneEvent.__replied[0]).includes('#DeepHelp'))

  // 出图跑在服务器上，字体栈必须包含 Linux 常见中文字体，否则汉字全是方框
  const tplSrc = fs.readFileSync(path.join(pluginDir, 'resources', 'help', 'index.html'), 'utf8')
  for (const [label, font] of [
    ['Noto Sans CJK', 'Noto Sans CJK SC'],
    ['思源黑体', 'Source Han Sans SC'],
    ['文泉驿正黑', 'WenQuanYi Zen Hei'],
    ['文泉驿微米黑', 'WenQuanYi Micro Hei']
  ]) {
    checkTrue('帮助图字体栈含 ' + label, tplSrc.includes(font))
  }
}

// ============================================================ 6.4 许可与免责
console.log('\n=== 6.4 许可与免责声明 ===')
const readPluginFile = (rel) => {
  const p = path.join(pluginDir, rel)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

const licenseText = readPluginFile('LICENSE')
checkTrue('存在 LICENSE 文件', licenseText.length > 0)
checkTrue('LICENSE 是 MIT 协议', licenseText.includes('MIT License'))
checkTrue('LICENSE 含标准免责条款',
  licenseText.includes('WITHOUT WARRANTY OF ANY KIND') &&
  licenseText.includes('AUTHORS OR COPYRIGHT HOLDERS BE LIABLE'))

const disclaimer = readPluginFile('DISCLAIMER.md')
checkTrue('存在 DISCLAIMER.md', disclaimer.length > 0)
checkTrue('声明里写明 MIT 协议', disclaimer.includes('MIT'))
for (const [label, needle] of [
  ['账号封禁风险', '封禁'],
  ['内容责任', '违法违规内容'],
  ['网络攻击', '网络攻击'],
  ['数据与隐私', '个人信息保护法'],
  ['密钥明文', 'data/cfg.json'],
  ['第三方服务', '第三方服务'],
  ['无担保与责任限制', '责任限制'],
  ['合规义务', '生成式人工智能服务管理暂行办法'],
  ['不可排除的责任', '不可排除'],
  ['使用即视为同意', '视为你已完整阅读']
]) {
  checkTrue(`声明覆盖：${label}`, disclaimer.includes(needle))
}

checkTrue('README 里链接了免责声明', readPluginFile('README.md').includes('DISCLAIMER.md'))
checkTrue('帮助图模板里有免责声明', readPluginFile('resources/help/index.html').includes('完整免责声明见'))

// ============================================================ 6.7 聊天记录器
console.log('\n=== 6.7 聊天记录器 ===')
{
  const recMod = await import(url('model/Recorder.js'))
  const Recorder = recMod.default
  const { segmentsToText } = recMod

  check('转文本：纯文本', segmentsToText([{ type: 'text', text: '你好' }]), '你好')
  check('转文本：图片', segmentsToText([{ type: 'text', text: '看图' }, { type: 'image', url: 'x' }]), '看图[图片]')
  check('转文本：艾特与表情', segmentsToText([{ type: 'at', qq: 123 }, { type: 'face', id: 1 }]), '@123[表情]')
  check('转文本：引用段不进正文',
    segmentsToText([{ type: 'reply', id: 'a' }, { type: 'text', text: '嗯' }]), '嗯')
  check('转文本：纯图片', segmentsToText([{ type: 'image', url: 'x' }]), '[图片]')
  check('转文本：只有引用段则为空', segmentsToText([{ type: 'reply', id: 'a' }]), '')
  check('转文本：字符串直接返回', segmentsToText('  直接传字符串  '), '直接传字符串')

  const gid = 777001
  const ev = (over = {}) => ({
    isGroup: true, group_id: gid, group_name: '测试群',
    user_id: 1001, self_id: 999,
    message: [{ type: 'text', text: '第一条' }],
    sender: { nickname: '甲', card: '' },
    ...over
  })

  check('没在记录时 capture 返回 false', Recorder.capture(ev()), false)
  checkTrue('开始记录返回元信息', !!Recorder.start(ev()))
  check('重复开始返回 null', Recorder.start(ev()), null)

  check('记录一条', Recorder.capture(ev()), true)
  Recorder.capture(ev({ user_id: 1002, sender: { nickname: '乙' }, message: [{ type: 'text', text: '第二条' }] }))
  check('机器人自己的发言默认不记',
    Recorder.capture(ev({ user_id: 999, message: [{ type: 'text', text: '我是机器人' }] })), false)
  check('只有引用段的消息不记',
    Recorder.capture(ev({ message: [{ type: 'reply', id: 'x' }] })), false)
  check('已记录条数', Recorder.get(ev()).count, 2)

  Cfg.set('recordIncludeBot', true)
  check('开启后记录机器人发言',
    Recorder.capture(ev({ user_id: 999, sender: { nickname: '机器人' }, message: [{ type: 'text', text: '我是机器人' }] })), true)
  Cfg.set('recordIncludeBot', false)

  const stopped = Recorder.stop(ev())
  check('结束后拿到 3 条', stopped.rows.length, 3)
  check('记录内容与顺序正确', stopped.rows.map((r) => r.msg), ['第一条', '第二条', '我是机器人'])
  check('昵称被记下来了', stopped.rows[0].name, '甲')
  check('结束后不再是记录状态', Recorder.isRecording(ev()), false)
  Recorder.removeFile(stopped.meta.key)

  Recorder.start(ev())
  Recorder.capture(ev())
  const cancelled = Recorder.cancel(ev())
  checkTrue('取消返回元信息', !!cancelled)
  check('取消后不再记录', Recorder.isRecording(ev()), false)
  check('取消后记录文件已删除',
    fs.existsSync(path.join(pluginDir, 'data', 'record', cancelled.key + '.jsonl')), false)

  Cfg.set('recordMaxMessages', 10)
  Recorder.start(ev())
  for (let i = 0; i < 15; i++) Recorder.capture(ev({ message: [{ type: 'text', text: '第' + i + '条' }] }))
  const capped = Recorder.stop(ev())
  check('超过上限后不再记录', capped.rows.length, 10)
  check('标记了已达上限', capped.meta.capped, true)
  Recorder.removeFile(capped.meta.key)
  Cfg.set('recordMaxMessages', 2000)

  const priv = { isGroup: false, user_id: 1001, self_id: 999, message: [{ type: 'text', text: '私聊一' }], sender: { nickname: '甲' } }
  Recorder.start(priv)
  Recorder.capture(priv)
  check('私聊与群聊的记录互不干扰', Recorder.isRecording(ev()), false)
  const privStop = Recorder.stop(priv)
  check('私聊记录内容', privStop.rows.map((r) => r.msg), ['私聊一'])
  Recorder.removeFile(privStop.meta.key)
}

// ============================================================ 6.8 定时群发
console.log('\n=== 6.8 定时群发 ===')
{
  const bcMod = await import(url('model/Broadcast.js'))
  const Broadcast = bcMod.default
  const { normalizeGroupIds, parseGapRange } = bcMod

  check('群列表：数字数组', normalizeGroupIds([123, 456]), [123, 456])
  check('群列表：字符串数组', normalizeGroupIds(['123', '456']), [123, 456])
  check('群列表：对象数组（GSelectGroup 形状）',
    normalizeGroupIds([{ id: 123, name: 'a' }, { group_id: '456' }]), [123, 456])
  check('群列表：去重', normalizeGroupIds([123, '123', 456]), [123, 456])
  check('群列表：逗号分隔字符串', normalizeGroupIds('123,456'), [123, 456])
  check('群列表：过滤非法值', normalizeGroupIds([0, -1, null, 'abc', 789]), [789])
  check('群列表：空字符串', normalizeGroupIds(''), [])
  check('群列表：null', normalizeGroupIds(null), [])

  check('间隔：10-60', parseGapRange('10-60'), { minMs: 10000, maxMs: 60000 })
  check('间隔：写反了也纠正', parseGapRange('60-10'), { minMs: 10000, maxMs: 60000 })
  check('间隔：空值用默认', parseGapRange(''), { minMs: 10000, maxMs: 60000 })
  check('间隔：只有空白也用默认', parseGapRange('   '), { minMs: 10000, maxMs: 60000 })
  check('间隔：单个数字表示固定值', parseGapRange('30'), { minMs: 30000, maxMs: 30000 })
  check('间隔：写一半也认', parseGapRange('15-'), { minMs: 15000, maxMs: 15000 })
  check('间隔：非数字用默认', parseGapRange('abc'), { minMs: 10000, maxMs: 60000 })
  check('间隔：上限封到 600 秒', parseGapRange('10-9999'), { minMs: 10000, maxMs: 600000 })

  check('没有任务时 status 为 null', Broadcast.status(), null)
  check('没有任务时 cancel 为 null', Broadcast.cancel(), null)

  const job = Broadcast.schedule({
    groups: [111, 222], content: '测试内容', delayMinutes: 60, gap: '10-60', by: '10001'
  })
  checkTrue('排定后拿到任务', !!job)
  check('排定后 status 有值', Broadcast.status().groups.length, 2)
  check('重复排定会被拒绝',
    Broadcast.schedule({ groups: [333], content: 'x', delayMinutes: 1, gap: '', by: '1' }), null)
  check('任务文件已写入', fs.existsSync(Broadcast.file), true)

  const cancelled = Broadcast.cancel()
  check('取消返回原任务', cancelled.groups.length, 2)
  check('取消后 status 为 null', Broadcast.status(), null)
  check('取消后任务文件已删除', fs.existsSync(Broadcast.file), false)
}

// ============================================================ 6.9 记录命令的准入
console.log('\n=== 6.9 #记录 命令的准入（逐群放行）===')
{
  const Recorder = (await import(url('model/Recorder.js'))).default
  const recApp = new (await import(url('apps/record.js'))).record({})
  const gid = 888001

  const evt = (over = {}) => ({
    isGroup: true, group_id: gid, group_name: '准入测试群',
    user_id: 30001, self_id: 999, msg: '#记录',
    message: [{ type: 'text', text: '#记录' }],
    sender: { nickname: '路人', role: 'member' },
    __replied: [],
    reply(msg) { this.__replied.push(String(msg)); return Promise.resolve({ message_id: 1 }) },
    ...over
  })

  Cfg.set('masterQQ', '10001')
  Cfg.set('adminQQ', [])
  Cfg.set('allowMemberRecord', false)
  Cfg.set('memberRecordAllowGroups', [])
  Cfg.set('memberRecordDenyGroups', [])

  const denied = evt()
  await recApp.start(denied)
  check('默认：成员发 #记录 被拒', /只有主人和管理员/.test(denied.__replied[0] || ''), true)
  check('被拒之后确实没开始记录', Recorder.isRecording(denied), false)
  checkTrue('拒绝文案里给了面板开关的指引', /允许普通成员使用聊天记录/.test(denied.__replied[0] || ''))

  Cfg.set('allowMemberRecord', true)
  const allowed = evt()
  await recApp.start(allowed)
  check('总开关打开后成员能开始记录', /已开始记录/.test(allowed.__replied[0] || ''), true)
  checkTrue('成员确实进入了记录状态', Recorder.isRecording(allowed))
  const cancelled = Recorder.cancel(allowed)
  Recorder.removeFile(cancelled.key)

  Cfg.set('memberRecordDenyGroups', [gid])
  const deniedAgain = evt()
  await recApp.start(deniedAgain)
  check('禁止列表里的群，成员又被拦回去', /只有主人和管理员/.test(deniedAgain.__replied[0] || ''), true)

  Cfg.set('adminQQ', ['20001'])
  const byAdmin = evt({ user_id: 20001 })
  await recApp.start(byAdmin)
  check('同一个群里管理员照常能用', /已开始记录/.test(byAdmin.__replied[0] || ''), true)
  const cancelled2 = Recorder.cancel(byAdmin)
  Recorder.removeFile(cancelled2.key)

  const byMemberStatus = evt()
  await recApp.status(byMemberStatus)
  check('#记录状态 也吃同一套准入', /只有主人和管理员/.test(byMemberStatus.__replied[0] || ''), true)

  Cfg.set('masterQQ', '')
  Cfg.set('adminQQ', [])
  Cfg.set('allowMemberRecord', false)
  Cfg.set('memberRecordDenyGroups', [])
}

// ============================================================ 6.10 海龟汤·汤面
console.log('\n=== 6.10 海龟汤汤面 ===')
{
  const Soup = (await import(url('model/Soup.js'))).default
  const soupMod = await import(url('apps/soup.js'))
  const { replyIdOf, findQuotedMessage } = await import(url('model/utils.js'))

  const gid = 880011
  const evt = (over = {}) => {
    const e = {
      isGroup: true, group_id: gid, group_name: '汤面测试群',
      user_id: 1001, self_id: 999,
      msg: '#汤面', message: [{ type: 'text', text: '#汤面' }],
      sender: { nickname: '甲', card: '甲' },
      __replied: [], __raw: []
    }
    e.reply = (msg) => {
      e.__raw.push(msg)
      e.__replied.push(String(msg))
      return Promise.resolve({ message_id: 7 })
    }
    return Object.assign(e, over)
  }

  const soupApp = new soupMod.soup()
  soupApp.e = evt()

  /** 一张「看起来像图片」的最小字节串（PNG 头 + 载荷），用来测落盘与回放 */
  const pngBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('PNGDATA')
  ])

  // ---- 引用关系：三种写法都要认
  check('引用 id：e.reply_id 优先', replyIdOf({ reply_id: 11, source: { message_id: 22 } }), '11')
  check('引用 id：退回 e.source', replyIdOf({ source: { message_id: 22 } }), '22')
  check('引用 id：再退回 reply 段', replyIdOf({ message: [{ type: 'reply', id: 33 }] }), '33')
  check('引用 id：都没有则为空', replyIdOf({ message: [{ type: 'text', text: 'x' }] }), '')
  check('引用 id：空事件不炸', replyIdOf(null), '')

  const windows = []
  const fallbackEvent = evt({
    message: [{ type: 'reply', id: 'm1' }],
    group: {
      getChatHistory: async (start, count) => {
        windows.push(count)
        return count >= 120 ? [{ message_id: 'm1', message: [{ type: 'text', text: '晚点才翻到' }] }] : []
      }
    }
  })
  const found = await findQuotedMessage(fallbackEvent, [30, 120])
  check('翻记录：先试小范围再扩大', windows, [30, 120])
  check('翻记录：扩大后拿到内容', found?.message?.[0]?.text, '晚点才翻到')
  check('翻记录：没引用就不去翻', await findQuotedMessage(evt(), [30]), null)

  // ---- 存储层：增删查、覆盖、隔离、过期
  Cfg.set('soupEnable', true)
  Cfg.set('soupAllowMember', true)
  Cfg.set('soupExpireHours', 24)
  Cfg.set('soupMaxImages', 3)
  Cfg.set('soupRefreshOnView', false)
  Cfg.set('masterQQ', '')
  Cfg.set('adminQQ', [])

  const quiet = evt()
  check('没记过的时候读不到汤面', Soup.get(quiet), null)

  const meta = Soup.save(quiet, { text: '他喝了一口汤就哭了' })
  check('记下的文字读得回来', Soup.get(quiet)?.text, '他喝了一口汤就哭了')
  check('默认存 24 小时', Math.round((meta.expiresAt - meta.createdAt) / 3600000), 24)
  check('汤面挂在会话上（key = 群号）', meta.key, `group_${gid}`)
  checkTrue('元信息落了盘', fs.existsSync(path.join(Soup.dir, `group_${gid}.json`)))

  const bytes = Buffer.from('SOUPPNG')
  const withImage = Soup.save(quiet, { text: '', images: [{ data: bytes, ext: '.png', url: 'https://example.com/a.png' }] })
  check('图片汤面：存下 1 张', withImage.images.length, 1)
  checkTrue('图片落了盘', fs.existsSync(path.join(Soup.dir, withImage.images[0].name)))
  check('图片字节读得回来', Soup.imageBuffer(withImage, withImage.images[0]).toString(), 'SOUPPNG')

  Soup.save(quiet, { text: '换一张', images: [{ data: bytes, ext: '.jpg' }] })
  check('重新记录会覆盖旧的', Soup.get(quiet)?.text, '换一张')
  check('覆盖时旧图被清掉', fs.existsSync(path.join(Soup.dir, withImage.images[0].name)), false)

  check('别的群看不到', Soup.get(evt({ group_id: 880012 })), null)
  check('私聊单独一份', Soup.get(evt({ isGroup: false, user_id: 1001 })), null)

  Cfg.set('soupExpireHours', 1)
  Soup.save(quiet, { text: '一小时后过期' })
  check('改了时长立刻按新的算', Math.round((Soup.get(quiet).expiresAt - Date.now()) / 60000), 60)
  Soup.get(quiet).expiresAt = Date.now() - 1
  check('过期后读不到', Soup.get(quiet), null)
  check('过期后元信息也清掉了', fs.existsSync(path.join(Soup.dir, `group_${gid}.json`)), false)
  Cfg.set('soupExpireHours', 24)

  // ---- 应用层：记 / 看 / 删
  const soupMsg = {
    message_id: 'soup-1',
    raw_message: '他喝了一口汤就哭了',
    message: [{ type: 'text', text: '他喝了一口汤就哭了' }]
  }
  const quote = (quoted, over = {}) => evt({
    message: [{ type: 'reply', id: quoted.message_id }, { type: 'text', text: '#汤面' }],
    group: { getChatHistory: async () => [quoted] },
    ...over
  })

  const emptyView = evt()
  await soupApp.soup(emptyView)
  checkTrue('没记过就查看时给出记录指引', /还没有记录汤面/.test(emptyView.__replied[0] || ''))

  const recordEvent = quote(soupMsg)
  await soupApp.soup(recordEvent)
  checkTrue('引用 + #汤面 记下了', /已记录/.test(recordEvent.__replied[0] || ''))

  const viewEvent = evt()
  await soupApp.soup(viewEvent)
  checkTrue('之后发 #汤面 能再看一次', /他喝了一口汤就哭了/.test(viewEvent.__replied[0] || ''))
  checkTrue('查看时带上了剩余时间', /还剩/.test(viewEvent.__replied[0] || ''))

  // 汤面属于会话，不属于发汤面的人：别人引用同一条也能记
  const byOther = quote(soupMsg, { user_id: 2002, sender: { nickname: '乙', card: '乙' } })
  await soupApp.soup(byOther)
  check('别人引用同一条汤面也能记', Soup.get(byOther)?.ownerName, '乙')

  // ---- 权限：普通成员开关
  Cfg.set('soupAllowMember', false)

  const deniedRecord = quote(soupMsg)
  await soupApp.soup(deniedRecord)
  checkTrue('关掉成员开关：成员记不了', /只有主人和管理员/.test(deniedRecord.__replied[0] || ''))
  checkTrue('拒绝文案给出面板指引', /允许普通成员使用/.test(deniedRecord.__replied[0] || ''))

  const deniedView = evt()
  await soupApp.soup(deniedView)
  checkTrue('查看不受成员开关影响', /他喝了一口汤就哭了/.test(deniedView.__replied[0] || ''))

  const deniedRemove = evt()
  await soupApp.remove(deniedRemove)
  checkTrue('关掉成员开关：成员删不了', /只有主人和管理员/.test(deniedRemove.__replied[0] || ''))

  Cfg.set('adminQQ', ['3003'])
  const byAdmin = quote(soupMsg, { user_id: 3003, sender: { nickname: '丙', card: '丙' } })
  await soupApp.soup(byAdmin)
  checkTrue('管理员不受开关限制', /已记录/.test(byAdmin.__replied[0] || ''))
  Cfg.set('adminQQ', [])
  Cfg.set('soupAllowMember', true)

  // ---- 图片汤面：本地临时文件 / 只有 URL / 内网地址
  fs.mkdirSync(Soup.dir, { recursive: true })
  const fixture = path.join(Soup.dir, 'fixture.png')
  fs.writeFileSync(fixture, pngBytes)

  const imgRecord = quote({ message_id: 'soup-img', message: [{ type: 'image', file: fixture }] })
  await soupApp.soup(imgRecord)
  checkTrue('引用图片也能记', /已记录/.test(imgRecord.__replied[0] || ''))
  check('图片汤面存下 1 张', Soup.get(imgRecord)?.images?.length, 1)
  check('记录时回一份图确认（走图片段）', imgRecord.__raw[1]?.type, 'image')
  check('图片段里装的是字节', Buffer.isBuffer(imgRecord.__raw[1]?.data?.file), true)

  const imgView = evt()
  await soupApp.soup(imgView)
  check('图片汤面查看时回的是图片段', imgView.__raw[1]?.type, 'image')
  check('回出来的字节和存的一致',
    imgView.__raw[1]?.data?.file?.toString('hex'), pngBytes.toString('hex'))

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(Buffer.from('REMOTEIMG'), {
    status: 200, headers: { 'content-type': 'image/webp' }
  })
  const remoteRecord = quote({ message_id: 'soup-remote', message: [{ type: 'image', url: 'https://example.com/remote.jpg' }] })
  await soupApp.soup(remoteRecord)
  const remoteMeta = Soup.get(remoteRecord)
  globalThis.fetch = originalFetch
  check('只有 URL 的图会被下载下来', remoteMeta?.images?.[0]?.bytes, 9)
  check('扩展名按 content-type 走', remoteMeta?.images?.[0]?.name?.endsWith('.webp'), true)

  // 适配器用本机端口供图（NapCat / Lagrange 一类很常见）：必须能拉下来，
  // 不能按「非公网」一刀切挡掉 —— 那正是「图片汤面存不下」的成因
  globalThis.fetch = async () => new Response(pngBytes, {
    status: 200, headers: { 'content-type': 'application/octet-stream' }
  })
  const localPortRecord = quote({ message_id: 'soup-local', message: [{ type: 'image', url: 'http://127.0.0.1:3000/img.jpg' }] })
  await soupApp.soup(localPortRecord)
  const localPortMeta = Soup.get(localPortRecord)
  globalThis.fetch = originalFetch
  check('本机端口供的图能拉下来', localPortMeta?.images?.length, 1)
  check('类型按文件头认，不看扩展名', localPortMeta?.images?.[0]?.name?.endsWith('.png'), true)

  // 下载失败：文字照常记，而且要把原因说出来
  globalThis.fetch = async () => new Response('nope', { status: 404 })
  const brokenRecord = quote({
    message_id: 'soup-broken',
    message: [{ type: 'image', url: 'https://example.com/gone.jpg' }, { type: 'text', text: '汤面在这' }]
  })
  await soupApp.soup(brokenRecord)
  globalThis.fetch = originalFetch
  check('下载失败时文字照常记', Soup.get(brokenRecord)?.text, '汤面在这')
  checkTrue('下载失败会把原因说出来', /图片下载失败/.test(brokenRecord.__replied[0] || ''))
  check('失败的那张不会留在汤面里', Soup.get(brokenRecord)?.images?.length, 0)

  // 云元数据地址：仍然挡掉（SSRF），同样给出原因
  const metaRecord = quote({
    message_id: 'soup-meta',
    message: [{ type: 'image', url: 'http://169.254.169.254/latest/meta-data/' }, { type: 'text', text: '汤面在这' }]
  })
  await soupApp.soup(metaRecord)
  check('元数据地址被挡下，文字照常记', Soup.get(metaRecord)?.text, '汤面在这')
  check('被挡下的图不会留在汤面里', Soup.get(metaRecord)?.images?.length, 0)

  // 适配器只给了相对路径，也要找得到
  const relRecord = quote({
    message_id: 'soup-rel',
    message: [{ type: 'image', file: path.relative(process.cwd(), fixture) }]
  })
  await soupApp.soup(relRecord)
  check('相对路径的图也能读到', Soup.get(relRecord)?.images?.length, 1)

  // 发图必须走「消息段」：OneBot v11（NapCat / Lagrange）只认段，
  // 裸 Buffer 会被展开成没有 type 的对象丢掉 —— 表现就是「什么都没发出去」
  {
    const segMeta = Soup.save(evt(), { text: 'segment 测试', images: [{ data: pngBytes, ext: '.png' }] })

    const segEvent = evt()
    const seen = []
    segEvent.reply = (msg) => { seen.push(msg); return Promise.resolve({ message_id: 10 }) }
    globalThis.segment = { image: (file) => ({ type: 'image', file }) }
    await soupApp.show(segEvent, segMeta)
    delete globalThis.segment
    check('有 segment 时优先用它发图', seen[1]?.type, 'image')
    check('segment.image 收到的是图片字节', Buffer.isBuffer(seen[1]?.file), true)

    const noSegEvent = evt()
    await soupApp.show(noSegEvent, segMeta)
    check('没有 segment 时用等价的图片段', noSegEvent.__raw[1]?.type, 'image')
    check('图片段里放的是 Buffer', Buffer.isBuffer(noSegEvent.__raw[1]?.data?.file), true)
  }

  // 段对象都发不出去时，才退回裸 Buffer（icqq 系的老写法）
  {
    const fbMeta = Soup.save(evt(), { text: '回退测试', images: [{ data: pngBytes, ext: '.png' }] })
    const fbEvent = evt()
    const raw = []
    let calls = 0
    fbEvent.reply = (msg) => {
      calls++
      raw.push(msg)
      if (calls === 2) return Promise.reject(new Error('这个方式不行'))
      return Promise.resolve({ message_id: 9 })
    }
    await soupApp.show(fbEvent, fbMeta)
    check('段对象发不出去时退回裸 Buffer', Buffer.isBuffer(raw[2]), true)
  }

  // 存下来的字节不像图片时，先把这件事说出来，别让人对着空白猜
  {
    const badMeta = Soup.save(evt(), { text: '坏图测试', images: [{ data: Buffer.from('NOTANIMAGE'), ext: '.jpg' }] })
    const badEvent = evt()
    await soupApp.show(badEvent, badMeta)
    checkTrue('字节不像图片时给出提示', /不像是图片/.test(badEvent.__replied.join('\n')))
  }

  // 适配器把聊天记录给成 CQ 码字符串时，也要能认出里面的图片
  globalThis.fetch = async () => new Response(pngBytes, {
    status: 200, headers: { 'content-type': 'image/png' }
  })
  const cqRecord = quote({
    message_id: 'soup-cq',
    message: '[CQ:image,file=abc.image,url=https://example.com/cq.jpg]'
  })
  await soupApp.soup(cqRecord)
  check('CQ 码字符串里的图片也能存下', Soup.get(cqRecord)?.images?.length, 1)

  // OneBot v11 的段结构：{ type: 'image', data: { url } }
  const ob11Record = quote({
    message_id: 'soup-ob11',
    message: [{ type: 'image', data: { url: 'https://example.com/ob11.jpg' } }]
  })
  await soupApp.soup(ob11Record)
  globalThis.fetch = originalFetch
  check('OneBot 结构的图片也能存下', Soup.get(ob11Record)?.images?.length, 1)

  // 命令容错：手机上多打一个空格、或者打了全角 ＃
  {
    const rules = (soupApp.rule || []).map((r) => r.reg)
    const matches = (text) => rules.some((reg) => new RegExp(reg).test(text))
    check('命令：普通写法', matches('#汤面'), true)
    check('命令：尾部多余空格', matches('#汤面 '), true)
    check('命令：全角 ＃', matches('＃汤面'), true)
    check('命令：删除汤面', matches('#删除汤面'), true)
    check('命令：不会误伤别的话', matches('#汤面好吃'), false)
    check('accept 不认领消息（不影响别的插件）', await soupApp.accept(evt({ msg: '#汤面' })), false)
  }

  // 超限的图不要直接丢，先自动缩小再存（缩放借宿主渲染器）
  {
    const pngHead = (w, h) => {
      const b = Buffer.alloc(33)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
      b.writeUInt32BE(13, 8)
      b.write('IHDR', 12, 'latin1')
      b.writeUInt32BE(w, 16)
      b.writeUInt32BE(h, 20)
      return b
    }

    Cfg.set('soupMaxImageMB', 1)
    Cfg.set('soupMaxImageSide', 10000)

    const bigFixture = path.join(Soup.dir, 'big.png')
    fs.writeFileSync(bigFixture, Buffer.concat([pngHead(20000, 20000), Buffer.alloc(2 * 1024 * 1024)]))

    let asked = null
    const bigEvent = quote({ message_id: 'soup-big', message: [{ type: 'image', file: bigFixture }] })
    bigEvent.runtime = {
      render: async (plugin, tpl, params) => {
        asked = { plugin, tpl, params }
        return Buffer.alloc(512 * 1024)
      }
    }
    await soupApp.soup(bigEvent)

    checkTrue('超限图不会直接丢，而是缩小后存下', /已记录/.test(bigEvent.__replied[0] || ''))
    checkTrue('回复里说明已自动缩小', /自动缩小/.test(bigEvent.__replied[0] || ''))
    check('存下来的是缩小后的字节', Soup.get(bigEvent)?.images?.[0]?.bytes, 512 * 1024)
    check('缩小时按单边上限给宽度', asked?.params?.width, 10000)
    check('走的是缩放模板', asked?.tpl, 'soup/shrink')

    fs.rmSync(bigFixture, { force: true })
    Cfg.set('soupMaxImageMB', 20)
    Cfg.set('soupMaxImageSide', 10000)
  }

  // ---- 删除
  const del = evt()
  await soupApp.remove(del)
  checkTrue('删除汤面', /已删除/.test(del.__replied[0] || ''))
  check('删完就读不到了', Soup.get(del), null)
  check('删完元信息文件也没了', fs.existsSync(path.join(Soup.dir, `group_${gid}.json`)), false)

  const afterDelete = evt()
  await soupApp.soup(afterDelete)
  checkTrue('删完再查看就是「没有记录」', /还没有记录汤面/.test(afterDelete.__replied[0] || ''))

  const nothingToDelete = evt()
  await soupApp.remove(nothingToDelete)
  checkTrue('没记过时删除给出提示', /没什么可删的/.test(nothingToDelete.__replied[0] || ''))

  // ---- 总开关
  Cfg.set('soupEnable', false)
  const disabled = evt()
  await soupApp.soup(disabled)
  checkTrue('关掉功能后 #汤面 不响应', /关闭/.test(disabled.__replied[0] || ''))
  const disabledRemove = evt()
  await soupApp.remove(disabledRemove)
  checkTrue('关掉功能后 #删除汤面 也不响应', /关闭/.test(disabledRemove.__replied[0] || ''))
  Cfg.set('soupEnable', true)

  fs.rmSync(fixture, { force: true })
}

// ============================================================ 6.11 发图统一入口
console.log('\n=== 6.11 发图统一入口 ===')
{
  const { imageCandidates, replyImage } = await import(url('model/message.js'))
  const bytes = Buffer.from('IMG')

  // 没有 segment 全局时：等价的消息段在前，裸 Buffer 兜底
  const plain = imageCandidates(bytes)
  check('候选写法至少两条', plain.length >= 2, true)
  check('第一条是图片段', plain[0].type, 'image')
  check('图片段里装 Buffer', Buffer.isBuffer(plain[0].data.file), true)
  check('最后一条兜底裸 Buffer', Buffer.isBuffer(plain[plain.length - 1]), true)

  // 有 segment 全局时：优先用 segment.image
  globalThis.segment = { image: (file) => ({ type: 'image', file }) }
  const withSeg = imageCandidates(bytes)
  delete globalThis.segment
  check('有 segment 时排在第一位', withSeg[0].type, 'image')
  check('segment.image 收到原始字节', withSeg[0].file, bytes)

  // replyImage：第一次成功就不再往下试
  const okEvent = { calls: 0, reply() { this.calls++; return Promise.resolve({}) } }
  check('发图成功返回 ok', (await replyImage(okEvent, bytes)).ok, true)
  check('成功时只发了一次', okEvent.calls, 1)

  // 全都抛错时返回 false，交给调用方兜底
  const failEvent = { calls: 0, reply() { this.calls++; return Promise.reject(new Error('不行')) } }
  const failRes = await replyImage(failEvent, bytes)
  check('全都失败返回 ok=false', failRes.ok, false)
  check('失败时把候选写法都试了', failEvent.calls >= 2, true)

  // 关键：宿主把失败塞在返回值里（不抛异常）也要认出来，
  // 否则「没发出去」会被当成「发出去了」，然后静默什么都不发
  const rejectedEvent = {
    calls: 0,
    reply() {
      this.calls++
      return Promise.resolve({
        status: 'failed',
        retcode: 1200,
        error: { message: 'EventChecker Failed: sendMsg' }
      })
    }
  }
  const rejected = await replyImage(rejectedEvent, bytes)
  check('返回值里带错误也算失败', rejected.ok, false)
  check('失败原因被带出来', /EventChecker/.test(rejected.error || ''), true)
  check('失败时把所有写法都试了', rejectedEvent.calls >= 2, true)

  // 返回值是 { error: [...] } 也算失败（TRSS 的 loader 就是这么包的）
  const errResEvent = { calls: 0, reply() { this.calls++; return Promise.resolve({ error: [new Error('发送消息错误')] }) } }
  check('返回 error 数组也算失败', (await replyImage(errResEvent, bytes)).ok, false)
}

// ============================================================ 6.12 图片尺寸与上限
console.log('\n=== 6.12 图片尺寸与上限 ===')
{
  const { readImageSize, isOverLimit, shrinkImage, normalizeExt } = await import(url('model/image.js'))

  const pngHeader = (w, h) => {
    const b = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
    b.writeUInt32BE(13, 8)
    b.write('IHDR', 12, 'latin1')
    b.writeUInt32BE(w, 16)
    b.writeUInt32BE(h, 20)
    return b
  }
  const jpegHeader = (w, h) => {
    const sof = Buffer.alloc(9)
    sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8
    sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7)
    return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14), sof])
  }
  const gifHeader = (w, h) => {
    const b = Buffer.alloc(16)
    b.write('GIF89a', 0, 'latin1')
    b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8)
    return b
  }
  const bmpHeader = (w, h) => {
    const b = Buffer.alloc(30)
    b.write('BM', 0, 'latin1')
    b.writeInt32LE(w, 18); b.writeInt32LE(h, 22)
    return b
  }
  const webpHeader = (w, h) => {
    const b = Buffer.alloc(30)
    b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1')
    const wm = w - 1, hm = h - 1
    b[24] = wm & 0xff; b[25] = (wm >> 8) & 0xff; b[26] = (wm >> 16) & 0xff
    b[27] = hm & 0xff; b[28] = (hm >> 8) & 0xff; b[29] = (hm >> 16) & 0xff
    return b
  }

  check('PNG 尺寸', readImageSize(pngHeader(1920, 1080)), { type: '.png', width: 1920, height: 1080 })
  check('JPEG 尺寸', readImageSize(jpegHeader(800, 600)), { type: '.jpg', height: 600, width: 800 })
  check('GIF 尺寸', readImageSize(gifHeader(320, 240)), { type: '.gif', width: 320, height: 240 })
  check('BMP 尺寸', readImageSize(bmpHeader(64, 48)), { type: '.bmp', width: 64, height: 48 })
  check('WebP 尺寸', readImageSize(webpHeader(4000, 3000)), { type: '.webp', width: 4000, height: 3000 })
  check('认不出的格式返回 null', readImageSize(Buffer.from('NOTANIMAGE____')), null)
  check('空 Buffer 不炸', readImageSize(Buffer.alloc(0)), null)

  check('后缀归一化：jpeg→jpg', normalizeExt('image/jpeg'), '.jpg')
  check('后缀归一化：认不出的清空', normalizeExt('image/avif'), '')

  const limits = { maxSide: 10000, maxBytes: 20 * 1024 * 1024 }
  check('正常图不超限', isOverLimit(readImageSize(pngHeader(1920, 1080)), 1024, limits), false)
  check('单边超限', isOverLimit(readImageSize(pngHeader(12000, 100)), 1024, limits), true)
  check('体积超限', isOverLimit(readImageSize(pngHeader(100, 100)), 21 * 1024 * 1024, limits), true)
  check('尺寸认不出时只看体积', isOverLimit(null, 1024, limits), false)

  // 缩放：借渲染器完成，模板收到的是本机文件 URL
  const captured = []
  const bigPng = Buffer.concat([pngHeader(20000, 20000), Buffer.alloc(2 * 1024 * 1024)])
  const renderEvent = {
    runtime: {
      render: async (plugin, tpl, params, cfg) => {
        captured.push({ plugin, tpl, params })
        return Buffer.alloc(1024 * 1024)
      }
    }
  }
  const shrunk = await shrinkImage(renderEvent, bigPng, readImageSize(bigPng), limits)
  check('超限图被缩到单边上限', shrunk?.width, 10000)
  check('缩放走的是宿主渲染器', captured[0]?.tpl, 'soup/shrink')
  check('模板拿到的是本机文件 URL', /^file:\/\//.test(String(captured[0]?.params?.src || '')), true)
  check('缩放结果给的是 jpg/png 之一', ['.jpg', '.png'].includes(shrunk?.ext), true)

  const tmpDir = path.join(pluginDir, 'data', 'tmp')
  const leftovers = fs.existsSync(tmpDir)
    ? fs.readdirSync(tmpDir).filter((f) => f.startsWith('shrink-')).length
    : 0
  check('缩放的临时文件用完就删', leftovers, 0)

  // 体积还超就继续收，直到装得下
  let rounds = 0
  const retryEvent = {
    runtime: {
      render: async () => {
        rounds++
        return Buffer.alloc(rounds === 1 ? 30 * 1024 * 1024 : 1024 * 1024)
      }
    }
  }
  const retried = await shrinkImage(retryEvent, bigPng, readImageSize(bigPng), limits)
  check('体积还超就再缩一轮', rounds, 2)
  check('第二轮成功后返回结果', retried?.width, 7500)

  check('没有渲染器时返回 null', await shrinkImage({}, bigPng, readImageSize(bigPng), limits), null)
}

// ============================================================ 6.13 人设预设与切换
console.log('\n=== 6.13 人设预设与切换 ===')
{
  const Prompt = (await import(url('model/Prompt.js'))).default
  const manageMod = await import(url('apps/manage.js'))
  const manageApp = new manageMod.manage()
  const ChatState = (await import(url('model/ChatState.js'))).default

  const evt = (over = {}) => mockEvent({ isGroup: true, group_id: 660011, user_id: 10001, ...over })

  const promptsDir = Prompt.promptDir()
  fs.rmSync(promptsDir, { recursive: true, force: true })

  Cfg.set('prompt', '默认人设：普通猫娘')
  Cfg.set('promptList', [])
  Cfg.set('masterQQ', '10001')
  Cfg.set('adminQQ', [])

  check('人设目录一开始是空的', Prompt.presetList().length, 0)

  const saveOne = evt({ msg: '#设置人设 严肃助手 你是严肃的助手。' })
  await manageApp.savePrompt(saveOne)
  checkTrue('保存人设成功', /已保存人设/.test(saveOne.__replied[0] || ''))
  check('人设存成了独立文件', fs.existsSync(path.join(promptsDir, '严肃助手.json')), true)

  const saveTwo = evt({ msg: '#设置人设 猫粮推销员 你是推销猫粮的。' })
  await manageApp.savePrompt(saveTwo)

  const list = Prompt.presetList()
  check('列表按文件来', list.map((p) => p.title), ['严肃助手', '猫粮推销员'])
  check('序号从 1 开始', list.map((p) => p.index), [1, 2])
  check('文件里存着内容', list[0].content, '你是严肃的助手。')

  check('按序号找人设', Prompt.findPreset('2')?.title, '猫粮推销员')
  check('按名字找人设', Prompt.findPreset('严肃助手')?.index, 1)
  check('名字可以部分匹配', Prompt.findPreset('推销')?.index, 2)
  check('找不到返回 null', Prompt.findPreset('不存在的人设'), null)

  const notMasterSave = evt({ user_id: 20002, msg: '#设置人设 坏人 不该存进去' })
  await manageApp.savePrompt(notMasterSave)
  checkTrue('非主人不能设置人设', /只有主人/.test(notMasterSave.__replied[0] || ''))
  check('被拒之后确实没写文件', fs.existsSync(path.join(promptsDir, '坏人.json')), false)

  const plain = evt()
  check('没切过时用面板默认', Prompt.activePrompt(plain).from, '面板默认')
  check('默认人设内容正确', Prompt.activePrompt(plain).content, '默认人设：普通猫娘')

  const notMaster = evt({ user_id: 20002 })
  await manageApp.switchPrompt(notMaster)
  checkTrue('非主人不能切换人设', /只有主人/.test(notMaster.__replied[0] || ''))

  const byIndex = evt({ msg: '#切换提示词1' })
  await manageApp.switchPrompt(byIndex)
  checkTrue('主人按序号切换', /人设 1\. 严肃助手/.test(byIndex.__replied[0] || ''))
  check('切换后立刻生效', Prompt.activePrompt(byIndex).content, '你是严肃的助手。')
  check('会话里记的是文件名（序号会变，名字不会）',
    ChatState.getPromptChoice(byIndex), '严肃助手')

  const byName = evt({ msg: '#切换提示词 猫粮推销员' })
  await manageApp.switchPrompt(byName)
  check('也可以按名字切换', Prompt.activePrompt(byName).title, '猫粮推销员')

  const missing = evt({ msg: '#切换提示词9' })
  await manageApp.switchPrompt(missing)
  checkTrue('序号不存在时给出提示', /没找到人设/.test(missing.__replied[0] || ''))

  const bare = evt({ msg: '#切换提示词' })
  await manageApp.switchPrompt(bare)
  checkTrue('不带参数时列出人设', /严肃助手/.test(bare.__replied[0] || ''))

  const back = evt({ msg: '#切换提示词0' })
  await manageApp.switchPrompt(back)
  check('切回默认后不再有会话选择', ChatState.getPromptChoice(back), null)
  check('回到面板默认人设', Prompt.activePrompt(back).content, '默认人设：普通猫娘')

  // 并行：不同会话各用各的
  const groupA = evt({ group_id: 660011 })
  const groupB = evt({ group_id: 660012 })
  ChatState.setPromptChoice(groupA, '严肃助手')
  ChatState.setPromptChoice(groupB, '猫粮推销员')
  check('A 群用人设 1', Prompt.activePrompt(groupA).title, '严肃助手')
  check('B 群同时用人设 2', Prompt.activePrompt(groupB).title, '猫粮推销员')

  const listEvent = evt()
  await manageApp.promptList(listEvent)
  checkTrue('列表能看到全部人设', /严肃助手/.test(listEvent.__replied[0] || ''))
  checkTrue('列表标出当前用的是哪套', /←当前/.test(listEvent.__replied[0] || ''))

  const notMasterList = evt({ user_id: 20002 })
  await manageApp.promptList(notMasterList)
  checkTrue('非主人也看不了列表', /只有主人/.test(notMasterList.__replied[0] || ''))

  // 真正发给模型的那段系统提示词，用的是选中的那套
  const sysMsg = chatInstance.buildSystemMessage(evt({ group_id: 660011 }), 'active')
  checkTrue('系统提示词用上选中的人设', /你是严肃的助手。/.test(sysMsg.content))
  checkTrue('系统提示词标出人设名', /（严肃助手）/.test(sysMsg.content))

  // 引用一条带 txt 文档的消息：人设内容从文件里读
  const txtFixture = path.join(pluginDir, 'data', 'tmp', 'card.txt')
  fs.mkdirSync(path.dirname(txtFixture), { recursive: true })
  fs.writeFileSync(txtFixture, '\uFEFF角色卡：这是从 txt 文档读进来的长人设。')

  const txtQuoted = { message_id: 'txt-1', message: [{ type: 'file', file: txtFixture, name: 'card.txt' }] }
  const fromTxt = evt({
    msg: '#设置人设 文件人设',
    message: [{ type: 'reply', id: 'txt-1' }, { type: 'text', text: '#设置人设 文件人设' }],
    group: { getChatHistory: async () => [txtQuoted] }
  })
  await manageApp.savePrompt(fromTxt)
  checkTrue('引用 txt 能存人设', /已保存人设/.test(fromTxt.__replied[0] || ''))
  checkTrue('回复里说明来源是文件', /文本文件/.test(fromTxt.__replied[0] || ''))
  check('txt 内容进人设了（BOM 也清掉）',
    Prompt.findPreset('文件人设')?.content, '角色卡：这是从 txt 文档读进来的长人设。')

  // OneBot v11 那种 { type:'file', data:{ file } } 也要认
  const ob11Quoted = { message_id: 'txt-2', message: [{ type: 'file', data: { file: txtFixture, name: 'card.txt' } }] }
  const fromOb11 = evt({
    msg: '#设置人设 OB11人设',
    message: [{ type: 'reply', id: 'txt-2' }],
    group: { getChatHistory: async () => [ob11Quoted] }
  })
  await manageApp.savePrompt(fromOb11)
  checkTrue('OneBot 结构的文件段也能读', /已保存人设/.test(fromOb11.__replied[0] || ''))

  fs.rmSync(txtFixture, { force: true })

  const del = evt({ msg: '#删除人设 文件人设' })
  await manageApp.removePrompt(del)
  checkTrue('删除人设', /已删除人设/.test(del.__replied[0] || ''))
  check('人设文件也删了', fs.existsSync(path.join(promptsDir, '文件人设.json')), false)

  // 面板那一栏：只回名字、不回内容（内容进了请求体就会撞 100KB 的 413）
  const rows = Prompt.panelRows()
  checkTrue('面板行不带内容', rows.every((row) => row.content === ''), true)
  checkTrue('面板行带文件名和显示名', rows.every((row) => row.key && row.title))

  Prompt.applyPanelRows(rows.map((row) => (row.key === '严肃助手' ? { ...row, title: '严肃助手改' } : row)))
  check('面板改显示名 → 文件跟着改名', fs.existsSync(path.join(promptsDir, '严肃助手改.json')), true)
  check('改名后旧文件不再留着', fs.existsSync(path.join(promptsDir, '严肃助手.json')), false)

  Prompt.applyPanelRows(Prompt.panelRows().map((row) => (
    row.key === '严肃助手改' ? { ...row, content: '面板填的新内容' } : row
  )))
  check('面板填了内容就覆盖文件', Prompt.findPreset('严肃助手改')?.content, '面板填的新内容')

  const kept = Prompt.findPreset('严肃助手改')?.content
  Prompt.applyPanelRows(Prompt.panelRows())
  check('内容留空则保持文件里原有的', Prompt.findPreset('严肃助手改')?.content, kept)

  const allRows = Prompt.panelRows()
  const removed = Prompt.applyPanelRows(allRows.slice(0, allRows.length - 1))
  check('面板删掉一整行 = 删掉这个人设', removed.removed, 1)

  // 老版本存在面板 promptList 里的预设：目录不存在时自动搬成文件
  fs.rmSync(promptsDir, { recursive: true, force: true })
  Cfg.set('promptList', [{ title: '老预设', content: '老内容' }])
  check('老预设自动搬进文件', Prompt.presetList()[0]?.title, '老预设')
  check('搬完之后就是文件了', fs.existsSync(path.join(promptsDir, '老预设.json')), true)

  fs.rmSync(promptsDir, { recursive: true, force: true })
  Cfg.set('promptList', [])
  Cfg.set('masterQQ', '')
  ChatState.clearAll()
}

console.log('\n=== 7. 清理测试产生的文件 ===')
const leftovers = ['data/cfg.json', 'data/state.json', 'data/record', 'data/broadcast.json', 'data/soup', 'data/tmp', 'data/prompts']
for (const rel of leftovers) {
  const p = path.join(pluginDir, rel)
  if (!fs.existsSync(p)) { console.log(`  ${rel} 不存在（无需清理）`); continue }
  fs.rmSync(p, { recursive: true, force: true })
  console.log(`  已删除 ${rel}`)
}

console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`)
process.exit(fail === 0 ? 0 : 1)
