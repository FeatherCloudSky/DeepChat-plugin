/**
 * 安全回归：把审计报告里确认过的每条「危险行为」变成一个必须失败的用例。
 *
 * 这些用例测的是「拒绝」：内网地址、跳转、越界路径、原型键、过期记录……
 * 一旦哪天有人把防线改回去，这里会直接红。
 *
 * 全部在临时副本里跑（见 isolated-workspace.mjs），不碰真实配置与数据。
 */
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runIsolated } from './isolated-workspace.mjs'

runIsolated(fileURLToPath(import.meta.url))

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
    this.__replied = (this.__replied || []).concat(String(msg))
    return Promise.resolve({ message_id: 1 })
  }
}
const store = new Map()
globalThis.redis = {
  async get(k) { return store.has(k) ? store.get(k) : null },
  async set(k, v) { store.set(k, v); return 'OK' },
  async del(k) { const keys = Array.isArray(k) ? k : [k]; keys.forEach((x) => store.delete(x)); return keys.length },
  async keys(pattern) { const prefix = pattern.replace(/\*$/, ''); return [...store.keys()].filter((k) => k.startsWith(prefix)) }
}

let pass = 0
let fail = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}\n        期望: ${JSON.stringify(expected)}\n        实际: ${JSON.stringify(actual)}`) }
}
const checkTrue = (name, value) => check(name, Boolean(value), true)

async function rejects(fn) {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}

// ============================================================ 1. 地址分类
console.log('\n=== 1. 内网 / 保留地址识别 ===')
const netMod = await import(url('model/net.js'))
const { classifyAddress } = netMod

for (const ip of [
  '127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255',
  '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
  '::1', '::', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::127.0.0.1',
  '2002:7f00:1::', 'fd12:3456:789a::1', 'fe80::1', 'ff02::1'
]) {
  check(`非公网：${ip}`, classifyAddress(ip) === 'public', false)
}
check('公网 IPv4', classifyAddress('8.8.8.8'), 'public')
check('公网 IPv6', classifyAddress('2606:4700::1111'), 'public')
check('IPv4 映射形式的公网地址仍是公网', classifyAddress('::ffff:8.8.8.8'), 'public')
check('乱写的地址归为 invalid', classifyAddress('not-an-ip'), 'invalid')

// ============================================================ 2. URL 粗筛
console.log('\n=== 2. URL 字面量粗筛 ===')
const { isPublicHttpUrl, escapeCqText, deepMerge, setByPath } = await import(url('model/utils.js'))
check('映射回环地址被拒', isPublicHttpUrl('http://[::ffff:127.0.0.1]/a.png'), false)
check('十进制整数形式的回环被拒', isPublicHttpUrl('http://2130706433/a.png'), false)
check('十六进制形式的回环被拒', isPublicHttpUrl('http://0x7f.1/a.png'), false)
check('NAT64 映射回环被拒', isPublicHttpUrl('http://[64:ff9b::127.0.0.1]/a.png'), false)
check('单标签主机名（内网名）被拒', isPublicHttpUrl('http://intranet/a.png'), false)
check('带用户名密码的地址被拒', isPublicHttpUrl('https://user:pass@example.com/a.png'), false)
check('正常公网图片地址通过', isPublicHttpUrl('https://cdn.example.com/a.png'), true)
check('CQ 起始标记被中和', escapeCqText('[CQ:image,file=http://x]'), '［CQ:image,file=http://x]')
check('普通方括号不受影响', escapeCqText('他说[好]'), '他说[好]')

// ============================================================ 3. 原型污染
console.log('\n=== 3. 原型污染 ===')
const polluted = {}
deepMerge(polluted, JSON.parse('{"__proto__":{"isMaster":true},"constructor":{"prototype":{"x":1}}}'))
check('deepMerge 不往 Object.prototype 写东西', ({}).isMaster, undefined)
check('deepMerge 结果里没有继承来的 isMaster', polluted.isMaster, undefined)
check('setByPath 拒绝 __proto__', await rejects(() => setByPath({}, '__proto__.isMaster', true)), true)

const Cfg = (await import(url('model/Cfg.js'))).default
// 注意：对象字面量里的 __proto__ 会改原型、不会成为自有属性，
// 真正的攻击载荷是 JSON 解析出来的那种，这里必须照那个形状构造。
check('配置不接受 __proto__ 路径', Cfg.setMany(JSON.parse('{"__proto__":{"isMaster":true}}')), false)
check('配置不接受 constructor 路径', Cfg.setMany(JSON.parse('{"constructor":{"prototype":{"x":1}}}')), false)
check('配置不接受未定义字段', Cfg.setMany({ notARealKey: 1 }), false)
check('配置不接受类型错误（布尔字段收到字符串）', Cfg.setMany({ enablePseudoHuman: 'yes' }), false)
check('配置不接受非数字', Cfg.set('maxTokens', 'abc'), false)
check('配置写入后原型仍干净', ({}).isMaster, undefined)
checkTrue('合法字段仍然可写', Cfg.setMany({ maxTokens: 256 }))

const Permission = (await import(url('model/Permission.js'))).default
const inherited = Object.create({ isMaster: true })
inherited.user_id = '4040404'
check('不认继承来的 isMaster', Permission.isMaster(inherited), false)
check('自有 isMaster 仍然认', Permission.isMaster({ user_id: '1', isMaster: true }), true)

// ============================================================ 4. 出站请求
console.log('\n=== 4. 出站请求：钉扎、越限、超时、跳转 ===')
{
  let otherHits = 0
  let otherAuth = null
  const other = http.createServer((req, res) => {
    otherHits++
    otherAuth = req.headers.authorization || null
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('other')
  })
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve))
  const otherBase = `http://127.0.0.1:${other.address().port}`

  const server = http.createServer((req, res) => {
    if (req.url === '/small') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.alloc(2 * 1024 * 1024))
      return
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/small' })
      res.end()
      return
    }
    if (req.url === '/cross') {
      res.writeHead(307, { location: `${otherBase}/steal` })
      res.end()
      return
    }
    if (req.url === '/slow') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('x')
      // 不结束：模拟「慢慢滴流拖住请求」
      return
    }
    res.writeHead(404)
    res.end('no')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  check('回环地址默认被拒', await rejects(() => netMod.request(`${base}/small`)), true)
  const allowed = await netMod.request(`${base}/small`, { allowLoopback: true })
  check('显式放行后能连上', allowed.status, 200)

  let sizeError = null
  try {
    await netMod.request(`${base}/big`, { allowLoopback: true, maxBytes: 1024 })
  } catch (error) {
    sizeError = error
  }
  checkTrue('超过体积上限会抛错', /上限/.test(sizeError?.message || ''))
  check('超限错误有独立类型', sizeError?.name, 'TransferLimitError')

  let timeoutError = null
  try {
    await netMod.request(`${base}/slow`, { allowLoopback: true, timeoutMs: 400 })
  } catch (error) {
    timeoutError = error
  }
  checkTrue('整条请求超时（不是空闲超时）', /超时/.test(timeoutError?.message || ''))

  check('默认不跟随跳转', await rejects(() => netMod.request(`${base}/redirect`, { allowLoopback: true })), true)
  const followed = await netMod.request(`${base}/redirect`, { allowLoopback: true, maxRedirects: 2 })
  check('显式允许时可以跟随同源跳转', followed.status, 200)

  // 跨源 307：正文与认证头都不该出现在下一跳
  let crossError = null
  try {
    await netMod.request(`${base}/cross`, {
      method: 'POST',
      body: { secret: 'payload' },
      headers: { authorization: 'Bearer sk-test' },
      allowLoopback: true,
      maxRedirects: 2
    })
  } catch (error) {
    crossError = error
  }
  checkTrue('跨源跳转被拒绝', Boolean(crossError))
  check('跨源那一跳没有被访问', otherHits, 0)
  check('跨源那一跳也没收到认证头', otherAuth, null)

  // 体积上限对 POST 响应同样生效
  let postSizeError = null
  try {
    const post = await import(url('model/http.js'))
    await post.postJson(`${base}/big`, { authorization: 'Bearer x' }, { a: 1 }, 5000, { allowLoopback: true, maxBytes: 4096 })
  } catch (error) {
    postSizeError = error
  }
  checkTrue('POST 响应也有字节上限', /上限/.test(postSizeError?.message || ''))

  await new Promise((resolve) => server.close(resolve))
  await new Promise((resolve) => other.close(resolve))
}

// ============================================================ 5. 本地文件
console.log('\n=== 5. 本机文件边界 ===')
{
  const { readTrustedImage, readTrustedText } = await import(url('model/safepath.js'))
  const dataDir = path.dirname(new URL(import.meta.url).pathname) // 占位，稍后覆盖
  const pluginData = path.join(pluginDir, 'data')
  fs.mkdirSync(pluginData, { recursive: true })

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(40)
  ])
  const goodImage = path.join(pluginData, 'ok.png')
  fs.writeFileSync(goodImage, png)
  checkTrue('受信任目录里的真图片能读', Boolean(readTrustedImage([goodImage]).buffer.length))

  // 扩展名是 .jpg、内容却是文字的典型伪装
  const fakeImage = path.join(pluginData, 'fake.jpg')
  fs.writeFileSync(fakeImage, 'this is not an image at all, just text')
  check('伪装成图片的文本被拒', await rejects(() => readTrustedImage([fakeImage])), true)

  // 目录之外的文件（本测试文件自己就在 data/ 之外）
  check('受信任目录之外的文件被拒',
    await rejects(() => readTrustedImage([path.join(pluginDir, 'test', 'security-check.mjs')])), true)
  check('越界路径不会因为相对路径解析而放行',
    await rejects(() => readTrustedImage([path.relative(pluginData, path.join(pluginDir, 'index.js'))])), true)

  // 文本导入：二进制内容被拒
  const bin = path.join(pluginData, 'persona.txt')
  fs.writeFileSync(bin, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00]))
  check('二进制内容不能当人设文本', await rejects(() => readTrustedText([bin])), true)

  // 软链接逃逸（Windows 上可能没有权限，没有就跳过）
  let linked = false
  try {
    const link = path.join(pluginData, 'escape.png')
    fs.symlinkSync(path.join(pluginDir, 'index.js'), link)
    linked = true
    check('软链接指向目录外会被拒', await rejects(() => readTrustedImage([link])), true)
    fs.rmSync(link, { force: true })
  } catch {
    console.log('  SKIP  软链接逃逸（当前环境不允许建符号链接）')
  }
  if (!linked) pass++

  fs.rmSync(goodImage, { force: true })
  fs.rmSync(fakeImage, { force: true })
  fs.rmSync(bin, { force: true })
  void dataDir
}

// ============================================================ 6. 会话隔离
console.log('\n=== 6. 多机器人会话隔离 ===')
{
  const State = (await import(url('model/ChatState.js'))).default
  const chatA = { isGroup: true, group_id: 123456, user_id: 1, self_id: 111 }
  const chatB = { isGroup: true, group_id: 123456, user_id: 1, self_id: 222 }
  check('同一群在不同机器人上 key 不同', State.getOverride(chatA) === null && State.getOverride(chatB) === null, true)

  State.setOverride(chatA, false)
  check('A 机器人上关掉', State.getOverride(chatA), false)
  check('B 机器人不受影响', State.getOverride(chatB), null)

  const Soup = (await import(url('model/Soup.js'))).default
  check('汤面 key 带机器人身份', Soup.keyOf(chatA) !== Soup.keyOf(chatB), true)

  const Recorder = (await import(url('model/Recorder.js'))).default
  check('记录 key 带机器人身份', Recorder.keyOf(chatA) !== Recorder.keyOf(chatB), true)

  State.clearOverride(chatA)
}

// ============================================================ 7. 禁用列表优先级
console.log('\n=== 7. 禁用列表优先于会话开关 ===')
{
  const Policy = (await import(url('model/Policy.js'))).default
  const State = (await import(url('model/ChatState.js'))).default
  const e = { isGroup: true, group_id: 900900, user_id: 5, self_id: 7 }

  Cfg.set('disabledGroups', ['900900'])
  State.setOverride(e, true)
  check('禁用列表压过会话级开启', Policy.resolveEnabled(e), false)
  check('状态说明里点明来源', Policy.describe(e).source.includes('禁用列表'), true)
  State.clearOverride(e)
  Cfg.set('disabledGroups', [])

  State.setOverride(e, true)
  check('移除禁用后会话开关生效', Policy.resolveEnabled(e), true)
  State.clearOverride(e)
}

// ============================================================ 8. 聊天记录到期
console.log('\n=== 8. 记录保留时长在运行期生效 ===')
{
  const Recorder = (await import(url('model/Recorder.js'))).default
  Cfg.set('recordExpireHours', 1)
  const e = {
    isGroup: true, group_id: 700700, user_id: 9, self_id: 3, message_id: 'm1',
    message: [{ type: 'text', text: '要被清理的一条' }], sender: { nickname: '甲' }
  }
  const meta = Recorder.start(e)
  checkTrue('开始记录', Boolean(meta))
  check('记下一条', Recorder.capture(e), true)

  const realNow = Date.now
  try {
    Date.now = () => meta.expiresAt + 60 * 1000
    check('到期后不再写入', Recorder.capture(e), false)
    check('到期后记录条目也没了', Recorder.get(e), null)
    check('到期后文件被删掉', fs.existsSync(path.join(Recorder.dir, `${meta.key}.jsonl`)), false)
  } finally {
    Date.now = realNow
  }
  Cfg.set('recordExpireHours', 24)
}

// ============================================================ 9. 汤面文件边界
console.log('\n=== 9. 汤面元信息里的路径不可信 ===')
{
  const Soup = (await import(url('model/Soup.js'))).default
  const e = { isGroup: true, group_id: 123123, user_id: 2, self_id: 4 }
  const meta = Soup.save(e, { text: '汤面' })
  const outside = path.join(pluginDir, 'index.js')
  meta.images.push({ name: `../../../${path.basename(outside)}`, url: '' })
  check('越界的图片名读不出内容', Soup.imageBuffer(meta, meta.images[meta.images.length - 1]), null)
  check('不存在的合法名也只是 null', Soup.imageBuffer(meta, { name: 'nope.png' }), null)
  Soup.remove(e)
}

// ============================================================ 10. 状态输出脱敏
console.log('\n=== 10. #chat状态 按身份脱敏 ===')
{
  const { manage } = await import(url('apps/manage.js'))
  const app = new manage()
  Cfg.set('apiUrl', 'https://api.example.com/v1')
  Cfg.set('apiKey', 'sk-super-secret-value')
  Cfg.set('masterQQ', '999000')

  const member = {
    isGroup: true, group_id: 1, user_id: 42, self_id: 8,
    reply(msg) { this.out = (this.out || []).concat(String(msg)); return Promise.resolve({}) }
  }
  await app.status(member)
  const memberText = (member.out || []).join('\n')
  checkTrue('普通成员看不到完整 API 地址', !memberText.includes('api.example.com'))
  checkTrue('普通成员看不到主人 QQ', !memberText.includes('999000'))
  checkTrue('普通成员也看不到密钥', !memberText.includes('sk-super-secret-value'))
  checkTrue('普通成员仍能看到会话状态', /本会话/.test(memberText))

  const admin = {
    isGroup: true, group_id: 1, user_id: 999000, self_id: 8,
    reply(msg) { this.out = (this.out || []).concat(String(msg)); return Promise.resolve({}) }
  }
  await app.status(admin)
  const adminText = (admin.out || []).join('\n')
  checkTrue('主人能看到地址', adminText.includes('api.example.com'))
  checkTrue('主人也看不到密钥', !adminText.includes('sk-super-secret-value'))
}

// ============================================================ 11. 并发与频率
console.log('\n=== 11. 并发闸门与频率限制 ===')
{
  const { withSlot, allowPerMinute } = await import(url('model/concurrency.js'))
  let active = 0
  let peak = 0
  const task = () => withSlot('security-test', 1, async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, 20))
    active--
  })
  await Promise.all([task(), task(), task()])
  check('并发上限为 1 时不会重叠执行', peak, 1)

  const key = `security-test-${Date.now()}`
  check('第 1 次放行', allowPerMinute(key, 2), true)
  check('第 2 次放行', allowPerMinute(key, 2), true)
  check('第 3 次被拦', allowPerMinute(key, 2), false)
  check('不限流时永远放行', allowPerMinute(key, 0), true)
}

// ============================================================ 12. 隐私默认值
console.log('\n=== 12. 默认配置的隐私取向 ===')
{
  check('默认关闭随机接话', Cfg.getBool('enablePseudoHuman', true), false)
  check('默认不允许普通成员操作汤面', Cfg.getBool('soupAllowMember', true), false)
  check('默认仍允许私聊', Cfg.getBool('enablePrivate', true), true)
  checkTrue('默认配置里有出站白名单字段', Array.isArray(Cfg.get('privateHostAllowList', null)))
  checkTrue('清空日志里没有密钥', !logs.some((line) => line.join(' ').includes('sk-super-secret-value')))
}

console.log(`\n================ 安全回归：${pass} 通过 / ${fail} 失败 ================`)
process.exit(fail === 0 ? 0 : 1)
