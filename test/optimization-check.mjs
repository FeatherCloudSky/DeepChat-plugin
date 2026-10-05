/** 在临时副本中验证优化行为，避免测试清理用户配置。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const script = fileURLToPath(import.meta.url)
const source = path.resolve(path.dirname(script), '..')
if (process.argv[2] !== '--isolated') {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'DeepChat-optimization-'))
  try {
    for (const name of ['model', 'apps', 'config', 'resources', 'test', 'index.js', 'package.json', 'guoba.support.js', '.gitignore', 'LICENSE', 'DISCLAIMER.md', 'README.md']) {
      fs.cpSync(path.join(source, name), path.join(temporary, name), { recursive: true })
    }
    fs.mkdirSync(path.join(temporary, 'data'))
    fs.copyFileSync(path.join(source, 'data/cfg_default.json'), path.join(temporary, 'data/cfg_default.json'))
    const result = spawnSync(process.execPath, [script, '--isolated', temporary], { cwd: temporary, stdio: 'inherit', timeout: 30000 })
    if (result.error) console.error(result.error.message)
    process.exitCode = result.status ?? 1
  } finally {
    const parent = path.resolve(os.tmpdir())
    const target = path.resolve(temporary)
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('DeepChat-optimization-')) throw new Error('临时目录边界不符')
    fs.rmSync(target, { recursive: true, force: true })
  }
} else {
  let checks = 0
  const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks++; console.log(`PASS ${name}`) }
  const logs = []
  globalThis.logger = Object.fromEntries(['info', 'warn', 'error', 'debug', 'mark'].map((level) => [level, (message) => logs.push(String(message))]))
  globalThis.logger.red = (s) => s
  globalThis.plugin = class { constructor(config) { Object.assign(this, config) } }
  const store = new Map()
  globalThis.redis = {
    get: async (key) => store.get(key) || null,
    set: async (key, value) => store.set(key, value),
    del: async (keys) => { for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key) },
    keys: async () => [...store.keys()]
  }
  const root = process.argv[3]
  const read = (name) => import(pathToFileURL(path.join(root, name)).href)
  const Cfg = (await read('model/Cfg.js')).default
  const Chat = (await read('apps/chat.js')).default
  const Provider = (await read('model/Provider.js')).default
  const State = (await read('model/ChatState.js')).default
  const Prompt = (await read('model/Prompt.js')).default
  const { cleanAnswer, trimDialog } = await read('model/Context.js')
  const { runInSession, runExclusive, QueueFullError } = await read('model/SessionQueue.js')
  const { classifyError, shouldDowngradeReasoning } = await read('model/Provider.js')
  const { retryAfterMs } = await read('model/http.js')
  const { supportGuoba } = await read('guoba.support.js')
  const client = new Chat()
  const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
  const event = (group = 1, content = '问题') => ({
    isGroup: true, group_id: group, user_id: 2, self_id: 3, msg: content,
    message: [{ type: 'text', text: content }], sender: { nickname: '甲', role: 'member' },
    group: { getChatHistory: async () => [] }, sent: [],
    async reply(text) { this.sent.push(text); return { message_id: 7 } }
  })
  Cfg.setMany({ historyCount: 0, replyDelayPerChar: 0, thinking: false, prompt: '旧人设', maxContextChars: 24000, sessionQueueLimit: 5 })

  // 兼容旧缓存，并确保热更新与模式变化在下一轮生效。
  const e = event()
  store.set(client.getCacheKey(e), JSON.stringify([{ role: 'system', content: '过时系统提示' }, { role: 'user', content: '历史问题' }, { role: 'assistant', content: '历史回答' }]))
  Cfg.set('prompt', '新人设')
  const active = await client.getContextWithHistory(e, '新问题', 'active', [])
  check('缓存保留历史对话', active.messages.some((m) => m.content === '历史回答'), true)
  check('系统提示使用最新人设', active.messages[0].content.includes('新人设'), true)
  check('旧系统提示被替换', active.messages.some((m) => m.content === '过时系统提示'), false)
  const pseudo = await client.getContextWithHistory(e, '插话', 'pseudo', [])
  check('模式变化重建系统提示', pseudo.messages[0].content.includes('以伪人模式'), true)
  check('主动模式不会沿用伪人提示', active.messages[0].content.includes('以伪人模式'), false)
  await client.saveToCache(e, active.cacheKey, active.messages, '新回答')
  check('缓存不保存 system', JSON.parse(store.get(active.cacheKey)).some((m) => m.role === 'system'), false)
  Cfg.set('maxContextLength', 1)
  await client.saveToCache(e, active.cacheKey, active.messages, '新回答')
  check('最小条数仍保留最近完整一轮', JSON.parse(store.get(active.cacheKey)).map((m) => m.role), ['user', 'assistant'])
  Cfg.set('maxContextLength', 25)

  const toText = Provider.partsToPlainText
  const history = [{ role: 'user', content: '旧'.repeat(900) }, { role: 'assistant', content: '旧回答' }, { role: 'user', content: '新问题' }]
  check('字符预算裁掉完整旧轮次', trimDialog(history, 25, 100, toText), [history[2]])
  check('不会保留孤立 assistant', trimDialog([{ role: 'assistant', content: '孤立' }, history[2]], 25, 100, toText), [history[2]])
  Cfg.set('maxContextChars', 1000)
  await assert.rejects(() => client.getContextWithHistory(e, '长'.repeat(1001), 'active', []), /过长/); checks++
  Cfg.set('maxContextChars', 24000)
  check('统一清理混合静默标记', cleanAnswer(' <empty>你好。<EMPTY> '), '你好。')

  const originalChat = Provider.chat
  Provider.chat = async () => '<EMPTY>'
  const silent = event(10)
  Cfg.set('splitReply', false)
  await client.processChat(silent, silent.msg)
  check('关闭拆条时静默不会发送', silent.sent, [])
  check('静默不会写入缓存', store.has(client.getCacheKey(silent)), false)
  Provider.chat = async () => '<EMPTY>你好。'
  await client.processChat(silent, silent.msg)
  check('关闭拆条时混合标记也被清理', silent.sent, ['你好。'])
  const failedSend = event(11)
  failedSend.reply = async () => { throw new Error('发送失败') }
  await assert.rejects(() => client.processChat(failedSend, failedSend.msg)); checks++
  check('发送失败不污染缓存', store.has(client.getCacheKey(failedSend)), false)
  const rejectedSend = event(14)
  rejectedSend.reply = async () => ({ status: 'failed', retcode: 1200 })
  await client.processChat(rejectedSend, rejectedSend.msg)
  check('宿主返回失败状态也不会写缓存', store.has(client.getCacheKey(rejectedSend)), false)
  Cfg.setMany({ splitReply: true, defaultVision: false, modelVision: [] })
  const quoted = event(12, '')
  quoted.message = [{ type: 'reply', id: 'image-quote' }]
  quoted.group.getChatHistory = async () => [{ message_id: 'image-quote', message: [{ type: 'image', url: 'https://example.com/a.jpg' }] }]
  let imageRequest
  Provider.chat = async (request) => { imageRequest = request; return '图片未识别。' }
  await client.chatCommand(quoted)
  check('纯引用图片可走命令并降级', toText(imageRequest.messages.at(-1).content).includes('[图片]'), true)
  const photo = event(13, '')
  photo.message = [{ type: 'image', url: 'https://example.com/a.jpg' }]
  await client.processChat(photo, '')
  check('纯图片不支持视觉也保留提示', photo.sent, ['图片未识别。'])

  // 两个插件实例共享队列，第二个请求必须看到第一个回答。
  const entered = deferred(), release = deferred()
  const requests = []
  Provider.chat = async (request) => {
    requests.push(request)
    if (requests.length === 1) { entered.resolve(); await release.promise }
    return requests.length === 1 ? '首个回答。' : '后续回答。'
  }
  const first = event(20, '第一问'), second = event(20, '第二问')
  const p1 = client.processChat(first, first.msg)
  await entered.promise
  const p2 = new Chat().processChat(second, second.msg)
  await Promise.resolve()
  check('同会话第二次请求尚未发出', requests.length, 1)
  check('忙碌时随机插话跳过', await client.processChat(event(20, '插话'), '插话', 'pseudo'), false)
  release.resolve()
  await Promise.all([p1, p2])
  check('后续请求包含首个回答', requests[1].messages.some((m) => m.content === '首个回答。'), true)
  check('两轮回复均完成', [first.sent, second.sent], [['首个回答。'], ['后续回答。']])
  const waiting = deferred(), resume = deferred()
  let busyCalls = 0
  Provider.chat = async () => { busyCalls++; waiting.resolve(); await resume.promise; return '已完成。' }
  Cfg.set('sessionQueueLimit', 1)
  const busy = event(21)
  const running = client.processChat(busy, busy.msg)
  await waiting.promise
  const overflow = event(21)
  await client.processChat(overflow, overflow.msg)
  check('队列满时主动请求获得提示', overflow.sent[0].includes('较多消息'), true)
  Cfg.set('sessionQueueLimit', 5)
  const pending = event(21)
  const queued = client.processChat(pending, pending.msg)
  State.setOverride(pending, false)
  resume.resolve(); await Promise.all([running, queued])
  check('排队期间关闭会话后不再调用模型', busyCalls, 1)
  check('已关闭会话的等待消息静默退出', pending.sent, [])
  State.clearOverride(pending)
  const resetStart = deferred(), resetFinish = deferred()
  Provider.chat = async () => { resetStart.resolve(); await resetFinish.promise; return '清理前回答。' }
  const resetEvent = event(22)
  const beforeReset = client.processChat(resetEvent, resetEvent.msg)
  await resetStart.promise
  const reset = client.endConversation(resetEvent)
  resetFinish.resolve(); await Promise.all([beforeReset, reset])
  check('结束对话不会被进行中的请求重新写入', store.has(client.getCacheKey(resetEvent)), false)
  const gate = deferred(), order = []
  const q1 = runInSession('bounded', async () => { await gate.promise; order.push(1) }, { limit: 1 })
  await assert.rejects(runInSession('bounded', async () => {}, { limit: 1 }), QueueFullError); checks++
  const other = await runInSession('other', () => '独立会话')
  check('不同会话可并行', other, '独立会话')
  const control = runInSession('bounded', () => order.push(2), { control: true })
  gate.resolve(); await Promise.all([q1, control])
  check('清理命令不受排队上限阻止', order, [1, 2])
  await assert.rejects(runInSession('failure', () => { throw new Error('失败') })); checks++
  check('队列失败后可继续使用', await runInSession('failure', () => '恢复'), '恢复')
  const hold = deferred(), sequence = []
  const before = runInSession('global', async () => { await hold.promise; sequence.push('旧请求') })
  const clear = runExclusive(() => sequence.push('清空'))
  const after = runInSession('new', () => sequence.push('新请求'))
  hold.resolve(); await Promise.all([before, clear, after])
  check('全局清空有前后顺序屏障', sequence, ['旧请求', '清空', '新请求'])
  Provider.chat = originalChat

  // 当前消息从初始宿主历史中排除。
  const recent = event(30)
  recent.message_id = 'current'
  recent.group.getChatHistory = async () => [{ message_id: 'current', user_id: 2, raw_message: '问题', message: [{ type: 'text', text: '问题' }] }]
  Cfg.set('historyCount', 7)
  check('初始历史不重复加入当前消息', await client.getChatHistory(recent), [])

  // 通过真实持久化模块模拟磁盘替换失败。
  Cfg.set('prompt', '可靠配置')
  const previousConfig = fs.readFileSync(Cfg.files.USER_FILE, 'utf8')
  State.setOverride(e, true)
  const previousState = fs.readFileSync(State.file, 'utf8')
  const rename = fs.renameSync
  fs.renameSync = () => { throw new Error('模拟磁盘写入失败') }
  try {
    check('配置保存失败返回 false', Cfg.set('prompt', '不应生效'), false)
    check('配置内存回滚', Cfg.get('prompt'), '可靠配置')
    check('配置原文件完整', fs.readFileSync(Cfg.files.USER_FILE, 'utf8'), previousConfig)
    check('会话保存失败返回 null', State.setOverride(e, false), null)
    check('会话内存回滚', State.getOverride(e), true)
    check('会话原文件完整', fs.readFileSync(State.file, 'utf8'), previousState)
    check('人设保存失败不报成功', Prompt.savePreset('失败人设', '内容'), null)
    const result = supportGuoba().configInfo.setConfigData({ prompt: '错误写入' }, { Result: { ok: () => ({ code: 0 }), error: (message) => ({ code: -1, message }) } })
    check('面板保存失败返回错误', result.code, -1)
    check('面板失败文案明确', result.message.includes('保存失败'), true)
    check('临时文件已清理', fs.readdirSync(path.join(root, 'data')).some((name) => name.endsWith('.tmp')), false)
  } finally { fs.renameSync = rename }

  check('401 不重试', classifyError(401).retryable, false)
  check('429 可以重试', classifyError(429).retryable, true)
  check('超时单独分类', classifyError(0, { name: 'AbortError' }).type, 'timeout')
  check('普通参数错误不误降档', shouldDowngradeReasoning('openai', 'max', { status: 400, data: { error: { message: 'Invalid image' } } }), false)
  check('明确思考参数错误才降档', shouldDowngradeReasoning('openai', 'max', { status: 422, data: { error: { param: 'reasoning_effort', message: 'unsupported max' } } }), true)
  check('Anthropic 不触发 OpenAI 降档', shouldDowngradeReasoning('anthropic', 'max', { status: 400, data: { error: { message: 'unsupported reasoning_effort max' } } }), false)
  check('Retry-After 秒数', retryAfterMs('2'), 2000)
  check('Retry-After 日期', retryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 1000), 4000)

  // 脚本化 fetch 响应验证请求次数、错误隔离与重试行为。
  const realFetch = globalThis.fetch
  Cfg.setMany({ apiKey: 'secret-key-one,secret-key-two', apiUrl: 'https://example.com/v1', model: 'test', useAnthropic: false, reasoningEffort: '', attemptMax: 3 })
  const invoke = async (responses) => {
    let calls = 0, failure = null
    const headers = []
    globalThis.fetch = async (url, options) => {
      headers.push(options.headers.authorization)
      const response = responses[Math.min(calls++, responses.length - 1)]
      if (response instanceof Error) throw response
      return new Response(JSON.stringify(response.body), { status: response.status, headers: response.headers })
    }
    const answer = await Provider.chat({ messages: [{ role: 'user', content: '测试' }], onError: (error) => { failure = error } })
    return { calls, failure, answer, headers }
  }
  try {
    const unauthorized = await invoke([{ status: 401, body: { error: { message: 'secret-key-one' } } }])
    check('真实请求路径鉴权失败只请求一次', unauthorized.calls, 1)
    check('鉴权错误向调用方分类反馈', unauthorized.failure.type, 'auth')
    check('错误正文密钥不会出现在日志', logs.some((line) => line.includes('secret-key-one')), false)
    const invalid = await invoke([{ status: 400, body: { error: { message: 'invalid image' } } }])
    check('参数错误只请求一次', invalid.calls, 1)
    const ok = { status: 200, body: { choices: [{ message: { content: '恢复成功' } }] } }
    const retried = await invoke([{ status: 429, body: { error: {} } }, ok])
    check('限流之后重试成功', [retried.calls, retried.answer], [2, '恢复成功'])
    check('可恢复错误重试时轮换密钥', retried.headers[0] !== retried.headers[1], true)
    const server = await invoke([{ status: 503, body: {} }, ok])
    check('服务异常之后重试成功', [server.calls, server.answer], [2, '恢复成功'])
    const longWait = await invoke([{ status: 429, body: {}, headers: { 'retry-after': '30' } }])
    check('长 Retry-After 不提前重试', longWait.calls, 1)
    const timeout = new Error('连接超时'); timeout.name = 'AbortError'
    const timed = await invoke([timeout, ok])
    check('超时之后可重试', [timed.calls, timed.answer], [2, '恢复成功'])
    Cfg.set('reasoningEffort', 'max')
    const unrelated = await invoke([{ status: 400, body: { error: { message: 'Invalid image' } } }])
    check('max 下图片报错不盲目降档', unrelated.calls, 1)
  } finally { globalThis.fetch = realFetch }

  const cfgBefore = fs.readFileSync(Cfg.files.USER_FILE, 'utf8')
  const stateBefore = fs.readFileSync(State.file, 'utf8')
  for (const name of ['offline-check.mjs', 'consistency-check.mjs']) {
    const result = spawnSync(process.execPath, [path.join(root, 'test', name)], { cwd: root, stdio: 'inherit', timeout: 30000 })
    if (result.error || result.status !== 0) console.error(result.error?.message || result.stdout || result.stderr)
    check(`${name} 临时副本执行成功`, result.status, 0)
    check(`${name} 保留使用配置`, fs.readFileSync(Cfg.files.USER_FILE, 'utf8'), cfgBefore)
    check(`${name} 保留会话状态`, fs.readFileSync(State.file, 'utf8'), stateBefore)
  }
  console.log(`\n优化回归：${checks} 项通过`)
  process.exit(0)
}
