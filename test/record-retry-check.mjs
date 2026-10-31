import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runIsolated } from './isolated-workspace.mjs'
runIsolated(fileURLToPath(import.meta.url))
globalThis.logger = Object.fromEntries(['info', 'warn', 'error', 'debug', 'mark'].map(k => [k, () => {}]))
globalThis.plugin = class { constructor(options) { Object.assign(this, options) } }
const { default: Cfg } = await import('../model/Cfg.js')
const { default: Recorder } = await import('../model/Recorder.js')
const { record: Record } = await import('../apps/record.js')
Cfg.set('recordOutput', 'text')
const e = { isMaster: true, isGroup: true, self_id: 9, group_id: 1, user_id: 2, sender: {}, message: [{ type: 'text', text: '记录内容' }], reply: async text => typeof text === 'string' && text.includes('记录内容') ? { status: 'failed' } : { message_id: 1 } }
Recorder.start(e)
assert.equal(Recorder.capture(e), true)
await new Record().stop(e)
assert.ok(Recorder.get(e), '发送失败应保留记录以便重试')
let exported = ''
e.reply = async text => { exported += text; return { message_id: 1 } }
await new Record().stop(e)
assert.match(exported, /记录内容/)
assert.equal(Recorder.get(e), null, '重试成功后结束记录')
console.log('聊天记录失败重试检查通过')
process.exit(0)
