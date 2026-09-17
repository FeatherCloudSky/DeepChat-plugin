import Recorder from '../model/Recorder.js'
import Permission from '../model/Permission.js'
import Cfg from '../model/Cfg.js'
import { pluginName } from '../config/constant.js'

const fmtTime = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false })

/** 按长度切块，用于纯文本兜底时避免单条消息过长被平台拒绝 */
function chunkText(text, size = 1500) {
  const out = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

function buildMarkdown(meta, rows) {
  const lines = [
    `# ${meta.label} 聊天记录`,
    '',
    `- 开始：${fmtTime(meta.startedAt)}`,
    `- 结束：${fmtTime(Date.now())}`,
    `- 条数：${rows.length}${meta.capped ? '（已达上限，后续消息未记录）' : ''}`,
    '',
    '---',
    ''
  ]
  for (const row of rows) {
    lines.push(`**${row.name}** \`${row.id}\` · ${fmtTime(row.t)}`)
    lines.push('')
    lines.push(row.msg.split('\n').map((line) => `> ${line}`).join('\n'))
    lines.push('')
  }
  return lines.join('\n')
}

function buildPlainText(meta, rows) {
  return [`【${meta.label} 聊天记录】共 ${rows.length} 条`, '']
    .concat(rows.map((r) => `${r.name}(${r.id}) ${fmtTime(r.t)}\n${r.msg}`))
    .join('\n')
}

/**
 * 合并转发（QQ 的「聊天记录」卡片）。
 * icqq 0.6.10 的类型定义里没有 makeForwardMsg，Yunzai 自己也是先判断存在再用，
 * 所以这里同样做存在性判断，拿不到就返回 null 交给下一级兜底。
 */
async function buildForward(e, meta, rows) {
  const target = e.isGroup ? e.group : e.friend
  const maker = target?.makeForwardMsg
  if (typeof maker !== 'function') return null

  const nodes = rows.map((row) => ({ user_id: row.id, nickname: row.name, message: row.msg }))
  try {
    const forward = await maker.call(target, nodes)
    try {
      const detail = forward?.data?.meta?.detail
      if (detail) detail.news = [{ text: `${meta.label} · 共 ${rows.length} 条` }]
    } catch (error) {
      // 卡片描述设不上不影响发送
    }
    return forward || null
  } catch (error) {
    logger.warn(`[${pluginName}] 生成合并转发失败：${error.message || error}`)
    return null
  }
}

/** 发 md 文件。Group 和 Friend 的 sendFile 签名不一样，要分开调 */
async function sendMarkdownFile(e, meta, rows) {
  const target = e.isGroup ? e.group : e.friend
  if (typeof target?.sendFile !== 'function') return false

  const buffer = Buffer.from(buildMarkdown(meta, rows), 'utf8')
  const filename = `${meta.label.replace(/[^\w\u4e00-\u9fa5-]/g, '_')}_聊天记录.md`
  try {
    if (e.isGroup) {
      await target.sendFile(buffer, undefined, filename)   // (file, pid?, name?)
    } else {
      await target.sendFile(buffer, filename)              // (file, filename?)
    }
    return true
  } catch (error) {
    logger.warn(`[${pluginName}] 发送 md 文件失败：${error.message || error}`)
    return false
  }
}

export class record extends plugin {
  constructor() {
    super({
      name: `[${pluginName}]记录`,
      dsc: '聊天记录',
      event: 'message',
      // 比 chat.js 更早 —— accept 是按优先级升序走的，这样每条消息都能先过一遍记录器
      priority: -4000,
      rule: [
        { reg: '^#记录$', fnc: 'start' },
        { reg: '^#结束记录$', fnc: 'stop' },
        { reg: '^#记录状态$', fnc: 'status' },
        { reg: '^#取消记录$', fnc: 'cancel' }
      ]
    })
  }

  /**
   * 每条消息都先过这里。返回 false = 「我不认领这条消息」，
   * loader 会继续把消息交给后面的插件 —— 所以记录不会干扰对话。
   */
  async accept(e) {
    try {
      Recorder.capture(e)
    } catch (error) {
      logger.debug(`[${pluginName}] 记录消息失败：${error.message || error}`)
    }
    return false
  }

  deny(e) {
    return e.reply(`只有主人和管理员才能操作聊天记录（你当前是${Permission.roleLabel(e)}）。`)
  }

  async start(e) {
    if (!Permission.isAdmin(e)) return this.deny(e)
    const meta = Recorder.start(e)
    if (!meta) return e.reply('这个会话已经在记录中了，发 #记录状态 可以看进度。')
    return e.reply(
      `已开始记录 ${meta.label} 的聊天消息。\n` +
      '再发 #结束记录 就打包发出来；不想要了就发 #取消记录。'
    )
  }

  async status(e) {
    if (!Permission.isAdmin(e)) return this.deny(e)
    const meta = Recorder.get(e)
    if (!meta) return e.reply('当前会话没有在记录。发送 #记录 开始。')
    const max = Cfg.getNumber('recordMaxMessages', 2000, 10, 100000)
    const minutes = Math.max(0, Math.round((Date.now() - meta.startedAt) / 60000))
    return e.reply(
      `正在记录 ${meta.label}\n` +
      `已记录：${meta.count} / ${max} 条${meta.capped ? '（已达上限）' : ''}\n` +
      `开始于：${fmtTime(meta.startedAt)}（约 ${minutes} 分钟前）`
    )
  }

  async cancel(e) {
    if (!Permission.isAdmin(e)) return this.deny(e)
    const meta = Recorder.cancel(e)
    if (!meta) return e.reply('当前会话没有在记录。')
    return e.reply(`已丢弃 ${meta.label} 的这次记录（${meta.count} 条），没有发出来。`)
  }

  async stop(e) {
    if (!Permission.isAdmin(e)) return this.deny(e)

    const result = Recorder.stop(e)
    if (!result) return e.reply('当前会话没有在记录。发送 #记录 开始。')

    const { meta, rows } = result
    if (rows.length === 0) {
      Recorder.removeFile(meta.key)
      return e.reply(
        `${meta.label} 这次一条消息都没记到。\n` +
        '常见原因：群里开启了「仅 @ 时响应」（onlyReplyAt 不是 0），普通消息到不了插件。'
      )
    }

    const mode = String(Cfg.get('recordOutput', 'auto')).toLowerCase()
    let sent = false

    if (mode === 'auto' || mode === 'forward') {
      const forward = await buildForward(e, meta, rows)
      if (forward) {
        await e.reply(forward)
        sent = true
      } else if (mode === 'forward') {
        await e.reply('合并转发在当前协议下不可用，改用文本发送。')
      }
    }

    if (!sent && (mode === 'auto' || mode === 'file')) {
      sent = await sendMarkdownFile(e, meta, rows)
      if (!sent && mode === 'file') {
        await e.reply('发送 md 文件失败（当前协议可能不支持发文件），改用文本发送。')
      }
    }

    if (!sent) {
      const chunks = chunkText(buildPlainText(meta, rows))
      for (const chunk of chunks) {
        await e.reply(chunk)
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    }

    // 发出去了才删文件；发送过程抛异常的话记录还留着，可以再发一次
    Recorder.removeFile(meta.key)
    return true
  }
}
