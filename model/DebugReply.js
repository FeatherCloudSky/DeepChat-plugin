import { isSendFailed } from './message.js'

/** 发送完整原始响应。单个转发节点用明确的文本段，避免把响应里的 CQ 码当作消息指令。 */
export async function sendDebugResponse(e, responses, failure) {
  let text = responses.map(({ attempt, status, text: body }, index) =>
    `【API 响应 ${index + 1} · 第 ${attempt} 次请求 · HTTP ${status}】\n${body}`
  ).join('\n\n')
  if (failure) text += `\n\n【请求最终状态】${failure.message || '请求未成功完成。'}`
  const target = e.isGroup ? e.group : e.friend
  if (typeof target?.makeForwardMsg === 'function') {
    try {
      const node = {
        user_id: e.self_id,
        nickname: e.bot?.info?.nickname || 'DeepChat 调试',
        message: [{ type: 'text', text }]
      }
      const forward = await target.makeForwardMsg([node])
      if (forward && !isSendFailed(forward) && !isSendFailed(await e.reply(forward))) return true
    } catch { /* 协议不支持时尝试文件，原文不会写入日志 */ }
  }
  if (typeof target?.sendFile === 'function') {
    try {
      const buffer = Buffer.from(text, 'utf8')
      const result = e.isGroup
        ? await target.sendFile(buffer, undefined, 'DeepChat-API调试.txt')
        : await target.sendFile(buffer, 'DeepChat-API调试.txt')
      if (!isSendFailed(result)) {
        await e.reply('当前协议无法发送折叠记录，完整 API 响应已作为文件发送。')
        return true
      }
    } catch { /* 由下方统一提示，不把原文输出到日志或普通消息 */ }
  }
  await e.reply('当前协议无法发送折叠记录或调试文件，API 原文未能发送；请检查适配器和消息体积。')
  return false
}
