/** 普通回复过滤思考块和静默标记；调试输出直接使用 API 原文。 */
export function cleanAnswer(answer) {
  let text = String(answer ?? '')
  text = text.replace(/<think\s*>[\s\S]*?<\/think\s*>/gi, '')
  // 有些接口不返回起始标签，只留下结束标签；结束标签以前按思考内容处理。
  const closing = /<\/think\s*>/gi
  let end = -1
  for (const match of text.matchAll(closing)) end = match.index + match[0].length
  if (end >= 0) text = text.slice(end)
  // 未闭合的思考块不应被当作答案发出。
  const opening = /<think\s*>/i.exec(text)
  if (opening) text = text.slice(0, opening.index)
  return text.replace(/<EMPTY>/gi, '').trim()
}

/** 按完整的 user 起始片段裁剪，不保留孤立的历史 assistant。 */
export function trimDialog(messages, maxMessages, maxChars, plainText) {
  const turns = []
  for (const message of messages) {
    if (!message || !['user', 'assistant'].includes(message.role)) continue
    if (!plainText(message.content).trim()) continue
    if (message.role === 'user') turns.push([])
    if (turns.length) turns[turns.length - 1].push(message)
  }
  const kept = []
  let chars = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    const size = turn.reduce((sum, message) => sum + plainText(message.content).length, 0)
    if (chars + size > maxChars || (kept.length > 0 && kept.length + turn.length > maxMessages)) break
    kept.unshift(...turn)
    chars += size
  }
  return kept
}
