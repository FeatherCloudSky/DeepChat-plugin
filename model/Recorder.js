/**
 * 聊天记录器。
 *
 * 用 JSONL 追加写盘（一条消息一行），而不是全量重写：
 *  - 追加是 O(1)，群聊刷屏时也不会有明显 IO；
 *  - 机器人中途重启，记录还在，能接着记。
 *
 * 每个会话一个文件：data/record/group_123456.jsonl / private_10001.jsonl
 * （文件名里不能有冒号，Windows 不允许，所以用下划线拼。）
 */
import fs from 'node:fs'
import path from 'node:path'
import Cfg from './Cfg.js'
import { pluginData, pluginName } from '../config/constant.js'

const DIR = path.join(pluginData, 'record')

/** key -> { key, label, startedAt, count, capped, isGroup, sessionId } */
const active = new Map()

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true })
}

function sessionKey(e) {
  return e?.isGroup ? `group_${e.group_id}` : `private_${e.user_id}`
}

function sessionLabel(e) {
  if (!e?.isGroup) return '私聊'
  return e.group_name ? `群「${e.group_name}」` : `群 ${e.group_id}`
}

function fileFor(key) {
  return path.join(DIR, `${key}.jsonl`)
}

/** 把消息段渲染成纯文本 —— 记录的是「能读的文字」，不是原始 CQ 码 */
export function segmentsToText(message) {
  if (typeof message === 'string') return message.trim()
  if (!Array.isArray(message)) return ''

  return message
    .map((seg) => {
      if (!seg) return ''
      switch (seg.type) {
        case 'text':   return seg.text ?? ''
        case 'image':  return '[图片]'
        case 'face':   return '[表情]'
        case 'record': return '[语音]'
        case 'video':  return '[视频]'
        case 'file':   return `[文件${seg.name ? ':' + seg.name : ''}]`
        case 'at':     return `@${seg.qq}`
        case 'reply':  return ''          // 引用关系不记进正文
        case 'json':   return '[卡片消息]'
        case 'xml':    return '[卡片消息]'
        default:       return `[${seg.type}]`
      }
    })
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

function readRecords(key) {
  try {
    const raw = fs.readFileSync(fileFor(key), 'utf8')
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line) } catch (e) { return null }
      })
      .filter(Boolean)
  } catch (error) {
    return []
  }
}

/**
 * 启动时：把没结束的记录捞回来（重启也能接着记），顺便清理过期的。
 *
 * 注意这里**不创建目录** —— 光 import 这个模块不该在磁盘上留东西，
 * 目录只在真正开始记录时才建（见 start / capture）。
 */
function restoreAndClean() {
  try {
    if (!fs.existsSync(DIR)) return
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl'))
    const expireHours = Cfg.getNumber('recordExpireHours', 24, 1, 24 * 30)
    const deadline = Date.now() - expireHours * 3600 * 1000
    let restored = 0
    let removed = 0

    for (const file of files) {
      const key = file.replace(/\.jsonl$/, '')
      const full = path.join(DIR, file)
      const stat = fs.statSync(full)

      if (stat.mtimeMs < deadline) {
        fs.unlinkSync(full)
        removed++
        continue
      }

      const rows = readRecords(key)
      if (rows.length === 0) { fs.unlinkSync(full); continue }

      const isGroup = key.startsWith('group_')
      const sessionId = key.replace(/^(group|private)_/, '')
      active.set(key, {
        key,
        isGroup,
        sessionId,
        label: isGroup ? `群 ${sessionId}` : '私聊',
        startedAt: rows[0].t || stat.birthtimeMs,
        count: rows.length,
        capped: false
      })
      restored++
    }

    if (restored > 0) logger.mark(`[${pluginName}] 恢复了 ${restored} 个未结束的聊天记录`)
    if (removed > 0) logger.info(`[${pluginName}] 清理了 ${removed} 个过期的聊天记录`)
  } catch (error) {
    logger.warn(`[${pluginName}] 恢复聊天记录失败：${error.message || error}`)
  }
}

restoreAndClean()

const Recorder = {
  dir: DIR,

  /** 会话 key，供外部展示用 */
  keyOf: sessionKey,

  get(e) {
    return active.get(sessionKey(e)) || null
  },

  isRecording(e) {
    return active.has(sessionKey(e))
  },

  /** 开始记录；已经记着了返回 null */
  start(e) {
    const key = sessionKey(e)
    if (active.has(key)) return null
    ensureDir()
    try {
      fs.writeFileSync(fileFor(key), '', 'utf8')
    } catch (error) {
      logger.warn(`[${pluginName}] 创建记录文件失败：${error.message || error}`)
      return null
    }
    const meta = {
      key,
      isGroup: !!e.isGroup,
      sessionId: String(e.isGroup ? e.group_id : e.user_id),
      label: sessionLabel(e),
      startedAt: Date.now(),
      count: 0,
      capped: false
    }
    active.set(key, meta)
    return meta
  },

  /** 结束记录：返回记录内容，文件先留着（发送成功后再删） */
  stop(e) {
    const key = sessionKey(e)
    const meta = active.get(key)
    if (!meta) return null
    active.delete(key)
    return { meta, rows: readRecords(key) }
  },

  /** 丢弃记录 */
  cancel(e) {
    const key = sessionKey(e)
    const meta = active.get(key)
    if (!meta) return null
    active.delete(key)
    try { fs.unlinkSync(fileFor(key)) } catch (error) { /* 文件可能本来就不在 */ }
    return meta
  },

  removeFile(key) {
    try { fs.unlinkSync(fileFor(key)) } catch (error) { /* 忽略 */ }
  },

  /**
   * 记录一条消息。没在记录、或是机器人自己发的（且配置不允许）就跳过。
   * @returns {boolean} 是否真的记下了
   */
  capture(e) {
    const key = sessionKey(e)
    const meta = active.get(key)
    if (!meta) return false

    if (!Cfg.getBool('recordIncludeBot', false) && String(e.user_id) === String(e.self_id)) {
      return false
    }

    const max = Cfg.getNumber('recordMaxMessages', 2000, 10, 100000)
    if (meta.count >= max) {
      if (!meta.capped) {
        meta.capped = true
        logger.warn(`[${pluginName}] ${meta.label} 的记录已达上限 ${max} 条，后续消息不再记录`)
      }
      return false
    }

    const text = segmentsToText(e.message)
    if (!text) return false

    const row = {
      t: Date.now(),
      id: String(e.user_id ?? ''),
      name: String(e.sender?.card || e.sender?.nickname || e.user_id || '未知'),
      msg: text
    }

    try {
      fs.appendFileSync(fileFor(key), JSON.stringify(row) + '\n', 'utf8')
      meta.count++
      return true
    } catch (error) {
      logger.warn(`[${pluginName}] 写入记录失败：${error.message || error}`)
      return false
    }
  },

  /** 当前所有进行中的记录（供 #记录状态 / 调试） */
  list() {
    return [...active.values()].map((m) => ({ ...m }))
  }
}

export default Recorder
