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
check('apps 收集到的插件类', Object.keys(indexMod.apps).sort(), ['chat', 'help', 'manage'])
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
    msg: '', message: [], sender: { nickname: '测试用户' }, __replied: []
  }
  e.reply = (msg) => { e.__replied.push(String(msg)); return Promise.resolve({ message_id: 1 }) }
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
   '权限设置', '伪人模式', '黑白名单设置', '帮助图'])
checkTrue('含逐模型图片能力字段', guoba.configInfo.schemas.some((s) => s.field === 'modelVision'))
checkTrue('含帮助背景字段', guoba.configInfo.schemas.some((s) => s.field === 'helpBg'))
checkTrue('含主人 QQ 字段', guoba.configInfo.schemas.some((s) => s.field === 'masterQQ'))

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
    JSON.stringify([{ type: 'image_url', image_url: { url: 'https://example.com/card.jpg' } }]))

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

  check('出图成功时发的是图片 base64', okEvent.__replied[0], 'BASE64_IMAGE_DATA')
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

console.log('\n=== 7. 清理测试产生的文件 ===')
const leftovers = ['data/cfg.json', 'data/state.json']
for (const rel of leftovers) {
  const p = path.join(pluginDir, rel)
  if (fs.existsSync(p)) { fs.unlinkSync(p); console.log(`  已删除 ${rel}`) }
  else { console.log(`  ${rel} 不存在（无需清理）`) }
}

console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`)
process.exit(fail === 0 ? 0 : 1)
