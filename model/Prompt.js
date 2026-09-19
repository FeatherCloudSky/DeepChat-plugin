/**
 * 人设（提示词）预设。
 *
 * 面板「基本配置 → 人设预设」里可以一次放好几套，主人用
 *   #切换提示词1        —— 按序号切
 *   #切换提示词 猫娘     —— 按名字切
 *   #切换提示词0        —— 回到面板里的默认人设
 * 给**当前会话**（群或私聊）切换。
 *
 * 为什么按会话而不是全局：不同群可以同时用不同人设（并行），
 * 这也和 #chat开 / #chat关 一直以来的粒度一致。
 * 没被指定过的会话，一律用面板里的默认人设 prompt。
 */
import Cfg from './Cfg.js'
import ChatState from './ChatState.js'

/** 面板里配的人设预设；过滤空行，序号从 1 开始 */
export function presetList() {
  const raw = Cfg.get('promptList', [])
  const rows = Array.isArray(raw) ? raw : []
  const list = []

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const title = String(row.title ?? '').trim()
    const content = String(row.content ?? '').trim()
    if (!title && !content) continue
    list.push({
      index: list.length + 1,
      title: title || `人设${list.length + 1}`,
      content
    })
  }

  return list
}

/** 按序号（1 起）或名字找人设，找不到返回 null */
export function findPreset(key) {
  const text = String(key ?? '').trim()
  if (!text) return null

  const list = presetList()
  if (/^\d+$/.test(text)) return list.find((preset) => preset.index === Number(text)) || null

  const lower = text.toLowerCase()
  return list.find((preset) => preset.title.toLowerCase() === lower) ||
    list.find((preset) => preset.title.toLowerCase().includes(lower)) ||
    null
}

/**
 * 当前会话真正生效的人设。
 * @returns {{index: number, title: string, content: string, from: string}}
 */
export function activePrompt(e) {
  const chosen = ChatState.getPromptIndex(e)
  if (chosen !== null) {
    const preset = presetList().find((item) => item.index === chosen)
    if (preset) return { ...preset, from: '本会话设置' }
  }

  return {
    index: 0,
    title: '',
    content: String(Cfg.get('prompt', '') || '').trim(),
    from: '面板默认'
  }
}

/** 给命令用的一行行说明 */
export function describeList(e) {
  const list = presetList()
  const active = activePrompt(e)
  const lines = [`【${Cfg.get('aiName', 'AI')} 的人设】`]

  if (list.length === 0) {
    lines.push('面板里还没有配人设预设（「基本配置 → 人设预设」），现在用的是默认人设。')
    return lines.join('\n')
  }

  for (const preset of list) {
    const mark = active.index === preset.index ? ' ←当前' : ''
    lines.push(`${preset.index}. ${preset.title}${mark}`)
  }
  lines.push('', `当前生效：${active.index === 0 ? '面板默认人设' : `${active.index}. ${active.title}`}（来自${active.from}）`)
  lines.push('切换： #切换提示词1　/　#切换提示词 名字　/　#切换提示词0（回到默认）')
  return lines.join('\n')
}

export default { presetList, findPreset, activePrompt, describeList }
