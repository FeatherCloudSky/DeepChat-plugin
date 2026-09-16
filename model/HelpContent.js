/**
 * 帮助内容的唯一来源：resources/help/help.md
 *
 * 解析规则很简单：
 *   # 标题          -> 文档标题
 *   ## 分组名       -> 一个分组
 *   - 命令 — 说明   -> 一条帮助项（分隔符支持 — / —— / - / 冒号）
 * 其余行忽略。想改帮助内容，直接改这个 md 再重启即可，不用碰代码。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pluginResources, pluginName } from '../config/constant.js'

const HELP_FILE = path.join(pluginResources, 'help', 'help.md')

const SEPARATORS = [' — ', ' —— ', ' - ', '：', ': ']

function splitEntry(body) {
  for (const separator of SEPARATORS) {
    const index = body.indexOf(separator)
    if (index > 0) {
      return {
        title: stripMarks(body.slice(0, index)),
        desc: stripMarks(body.slice(index + separator.length))
      }
    }
  }
  return { title: stripMarks(body), desc: '' }
}

/** 去掉 markdown 的行内代码反引号与粗体星号，图片里不需要这些标记 */
function stripMarks(text) {
  return String(text ?? '').replace(/`/g, '').replace(/\*\*/g, '').trim()
}

/** 把 markdown 解析成 { title, groups: [{ group, list: [{ title, desc }] }] } */
export function parseHelpMarkdown(markdown) {
  const result = { title: '', groups: [] }
  let current = null

  for (const raw of String(markdown ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue

    if (line.startsWith('## ')) {
      current = { group: line.slice(3).trim(), list: [] }
      result.groups.push(current)
      continue
    }
    if (line.startsWith('# ')) {
      if (!result.title) result.title = line.slice(2).trim()
      continue
    }
    if (!line.startsWith('- ') && !line.startsWith('* ')) continue
    if (!current) continue

    const entry = splitEntry(line.slice(2))
    if (entry.title) current.list.push(entry)
  }

  return result
}

/** 读取并解析 help.md，失败时返回一份内置的兜底内容 */
export function loadHelp() {
  try {
    const markdown = fs.readFileSync(HELP_FILE, 'utf8')
    const parsed = parseHelpMarkdown(markdown)
    if (parsed.groups.length > 0) return parsed
    logger.warn(`[${pluginName}] help.md 里没有解析出任何分组，使用内置兜底内容`)
  } catch (error) {
    logger.warn(`[${pluginName}] 读取 help.md 失败：${error.message || error}`)
  }

  return {
    title: `${pluginName} 帮助`,
    groups: [{
      group: '对话',
      list: [
        { title: '#chat 内容', desc: '主动和 AI 对话' },
        { title: '#结束对话', desc: '清空当前会话的上下文' },
        { title: '#chat开 / #chat关', desc: '开关当前群或私聊' },
        { title: '#DeepHelp', desc: '打开帮助' }
      ]
    }]
  }
}

/** 渲染成纯文本，供 #chat状态 或渲染失败时兜底 */
export function toPlainText(content) {
  const lines = [`【${content.title}】`, '']
  for (const group of content.groups) {
    lines.push(`▎${group.group}`)
    for (const item of group.list) {
      lines.push(`　${item.title}${item.desc ? ` — ${item.desc}` : ''}`)
    }
    lines.push('')
  }
  return lines.join('\n').trim()
}

export default { loadHelp, parseHelpMarkdown, toPlainText, HELP_FILE }
