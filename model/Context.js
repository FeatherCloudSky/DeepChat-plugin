/** 静默标记在缓存和发送前处理，与分条开关无关。 */
export function cleanAnswer(answer) {
  return String(answer ?? '').replace(/<EMPTY>/gi, '').trim()
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
