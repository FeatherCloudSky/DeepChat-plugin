/** 只在隔离副本和本机假 API 上测试调试功能，不使用真实配置或凭据。 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runIsolated } from './isolated-workspace.mjs'

runIsolated(fileURLToPath(import.meta.url))
const logs = []
globalThis.logger = Object.fromEntries(['info', 'warn', 'error', 'debug', 'mark'].map(k => [k, m => logs.push(String(m))]))
globalThis.logger.red = s => s
globalThis.plugin = class { constructor(config) { Object.assign(this, config) } }
const store = new Map()
globalThis.redis = {
  get: async key => store.get(key) || null,
  set: async (key, value) => store.set(key, value),
  del: async key => store.delete(key),
  keys: async () => [...store.keys()]
}
const { default: Cfg } = await import('../model/Cfg.js')
const { default: State } = await import('../model/ChatState.js')
const { default: Provider } = await import('../model/Provider.js')
const { manage: Manage } = await import('../apps/manage.js')
const { default: Chat } = await import('../apps/chat.js')
let checks = 0
function check(name, actual, expected) { assert.deepEqual(actual, expected, name); checks++; console.log(`PASS ${name}`) }
const queue = []
let redirectTargetHits = 0
const server = http.createServer((req, res) => {
  if (req.url === '/redirect-target') { redirectTargetHits++; res.end('unexpected'); return }
  req.resume()
  req.on('end', async () => {
    const item = queue.shift()
    if (item.arrived) item.arrived()
    if (item.wait) await item.wait
    res.writeHead(item.status, { 'content-type': 'application/json', ...(item.location ? { location: item.location } : {}) })
    res.end(item.text)
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const port = server.address().port
  check('配置本机假 API', Cfg.setMany({ apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'TEST_FAKE_KEY', model: 'fake-model', attemptMax: 2, includeHistory: false, historyCount: 0, thinking: false, replyDelayPerChar: 0, userRatePerMinute: 0 }), true)
  const rawGood = '{"choices":[{"message":{"content":"回答。第二句","reasoning_content":"完整思考 <EMPTY> [CQ:fake]"}}],"usage":{"completion_tokens":42}}'
  const rawError = '{ "error": { "message": "完整错误 原始正文" }, "extra": "原样" }'
  const opts = raw => ({ messages: [{ role: 'user', content: '测试' }], onRawResponse: response => raw.push(response) })
  let raw = []
  queue.push({ status: 200, text: rawGood })
  check('正常响应抽取原回答', await Provider.chat(opts(raw)), '回答。第二句')
  check('成功正文不隐藏思考、标记和附加字段', raw.map(x => [x.status, x.text]), [[200, rawGood]])
  raw = []
  queue.push({ status: 400, text: rawError })
  check('错误响应不会产生正常回答', await Provider.chat(opts(raw)), null)
  check('错误状态及原文被捕获', raw.map(x => [x.status, x.text]), [[400, rawError]])
  raw = []
  queue.push({ status: 503, text: rawError }, { status: 200, text: rawGood })
  check('可重试错误后成功', await Provider.chat(opts(raw)), '回答。第二句')
  check('两次响应都按原文与顺序捕获', raw.map(x => [x.status, x.text]), [[503, rawError], [200, rawGood]])
  Cfg.set('attemptMax', 1)
  raw = []
  const redirectBody = '{ "redirect": "完整原文" }'
  queue.push({ status: 307, text: redirectBody, location: `http://127.0.0.1:${port}/redirect-target` })
  check('禁止跟随跳转时不产生正常回答', await Provider.chat(opts(raw)), null)
  check('禁止跳转前捕获完整 307 正文', raw.map(x => [x.status, x.text]), [[307, redirectBody]])
  check('调试不会访问跳转目标', redirectTargetHits, 0)
  Cfg.set('maxResponseMB', 1)
  raw = []
  queue.push({ status: 200, text: 'x'.repeat(1024 * 1024 + 1) })
  check('调试状态下响应体超限仍拒绝', await Provider.chat(opts(raw)), null)
  check('不将超限截断内容伪装成完整原文', raw.length, 0)
  Cfg.set('maxResponseMB', 8)
  Cfg.set('attemptMax', 2)
  const makeEvent = (group = 1, isMaster = true) => ({
    self_id: 700, user_id: isMaster ? 100 : 101, group_id: group, isGroup: true, isMaster,
    msg: '测试', message: [{ type: 'text', text: '测试' }], sender: { nickname: '甲' },
    group: { getChatHistory: async () => [] }, sent: [],
    async reply(message) { this.sent.push(message); return { message_id: 1 } }
  })
  const mgr = new Manage()
  const denied = makeEvent(3, false)
  await mgr.enableDebug(denied)
  check('普通成员不能开启调试', State.isDebugEnabled(denied), false)
  const event = makeEvent()
  await mgr.enableDebug(event)
  check('主人可开启当前会话调试', State.isDebugEnabled(event), true)
  check('其他群不受影响', State.isDebugEnabled(makeEvent(2)), false)
  check('其他机器人不受影响', State.isDebugEnabled({ ...event, self_id: 701 }), false)
  const privateEvent = { ...makeEvent(), isGroup: false, user_id: 100, friend: { getChatHistory: async () => [] } }
  check('相同标识的私聊不继承群调试状态', State.isDebugEnabled(privateEvent), false)
  await mgr.enableDebug(privateEvent)
  check('私聊可以单独打开调试', State.isDebugEnabled(privateEvent), true)
  await mgr.disableDebug(privateEvent)
  check('关闭私聊不影响群', State.isDebugEnabled(event), true)
  const reloaded = spawnSync(process.execPath, ['--input-type=module', '-e', `
    globalThis.logger = Object.fromEntries(['info','warn','error','debug','mark'].map(k => [k, () => {}]));
    const { default: state } = await import('./model/ChatState.js');
    console.log(JSON.stringify({ group: state.isDebugEnabled({ isGroup: true, self_id: 700, group_id: 1 }), private: state.isDebugEnabled({ isGroup: false, self_id: 700, user_id: 100 }) }));
    process.exit(0);
  `], { cwd: process.cwd(), encoding: 'utf8' })
  check('新进程重载成功', reloaded.status, 0)
  check('调试状态跨进程持久化且私聊独立', JSON.parse(reloaded.stdout), { group: true, private: false })
  await mgr.disableDebug(event)
  check('关闭后恢复正常模式', State.isDebugEnabled(event), false)
  const client = new Chat()
  const regular = makeEvent(10)
  queue.push({ status: 200, text: rawGood })
  await client.processChat(regular, '测试')
  check('正常模式按原逻辑分条回复', regular.sent, ['回答。', '第二句'])

  const folded = makeEvent(11)
  await mgr.enableDebug(folded)
  folded.sent = []
  folded.group.makeForwardMsg = async nodes => ({ nodes })
  queue.push({ status: 200, text: rawGood })
  await client.processChat(folded, '测试')
  check('调试仅发一条折叠消息', folded.sent.length, 1)
  const node = folded.sent[0].nodes[0]
  check('折叠内为明确的纯文本消息段', node.message[0].type, 'text')
  check('折叠中完整保留原始正文', node.message[0].text.endsWith(rawGood), true)
  check('折叠中保留思考内容和特殊标记', node.message[0].text.includes('完整思考 <EMPTY> [CQ:fake]'), true)

  const fallback = makeEvent(12)
  await mgr.enableDebug(fallback)
  fallback.sent = []
  let fileContent = ''
  fallback.group.sendFile = async buffer => { fileContent = buffer.toString('utf8'); return { status: 'ok' } }
  queue.push({ status: 400, text: rawError })
  await client.processChat(fallback, '测试')
  check('缺少折叠能力时文件保留完整错误正文', fileContent.includes(rawError), true)
  check('文件降级有明确提示', fallback.sent.some(s => typeof s === 'string' && s.includes('文件')), true)
  const failedForward = makeEvent(14)
  await mgr.enableDebug(failedForward)
  failedForward.sent = []
  failedForward.group.makeForwardMsg = async nodes => ({ nodes })
  let fallbackFile = ''
  failedForward.group.sendFile = async buffer => { fallbackFile = buffer.toString('utf8'); return { status: 'ok' } }
  failedForward.reply = async message => {
    failedForward.sent.push(message)
    return typeof message === 'object' ? { status: 'failed' } : { message_id: 1 }
  }
  queue.push({ status: 200, text: rawGood })
  await client.processChat(failedForward, '测试')
  check('折叠发送失败时回退完整文件', fallbackFile.includes(rawGood), true)
  const unsupported = makeEvent(13)
  await mgr.enableDebug(unsupported)
  unsupported.sent = []
  queue.push({ status: 200, text: rawGood })
  await client.processChat(unsupported, '测试')
  check('不支持折叠与文件时明确告知', unsupported.sent.some(s => typeof s === 'string' && s.includes('未能发送')), true)
  await mgr.disableDebug(folded)
  folded.sent = []
  queue.push({ status: 200, text: rawGood })
  await client.processChat(folded, '测试')
  check('关闭调试后恢复正常回复', folded.sent, ['回答。', '第二句'])
  const racing = makeEvent(15)
  await mgr.enableDebug(racing)
  racing.sent = []
  let release, arrived
  const wait = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { arrived = resolve })
  queue.push({ status: 200, text: rawGood, wait, arrived })
  const pending = client.processChat(racing, '测试')
  await started
  await mgr.disableDebug(racing)
  racing.sent = []
  release()
  await pending
  check('响应返回前关闭调试后正常回复', racing.sent, ['回答。', '第二句'])
  check('日志不含响应正文或 Key', logs.some(s => s.includes(rawGood) || s.includes(rawError) || s.includes('TEST_FAKE_KEY')), false)
  console.log(`调试模式：${checks} 项通过`)
} finally {
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
}
process.exit(0)
