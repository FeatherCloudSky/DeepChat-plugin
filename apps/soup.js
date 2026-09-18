/**
 * 海龟汤：把「汤面」临时存起来，随时再放出来看。
 *
 * 用法：
 *   引用（长按 → 引用）那条汤面消息，发 #汤面  → 记下来
 *   之后再发 #汤面                              → 再看一次
 *   发 #删除汤面                                → 删掉
 *
 * 汤面属于会话，不属于发汤面的人：A 发的汤面，B / C / D 谁引用都能记、都能删。
 * 能不能用由面板「海龟汤 → 允许普通成员使用」决定；查看永远不受限制
 * （汤面本来就是放给大家看的，锁上就没法玩了）。
 */
import fs from 'node:fs'
import path from 'node:path'
import Soup from '../model/Soup.js'
import Cfg from '../model/Cfg.js'
import Permission from '../model/Permission.js'
import { getBuffer } from '../model/http.js'
import { pluginName } from '../config/constant.js'
import { findQuotedMessage, isPublicHttpUrl } from '../model/utils.js'

/** 单张汤面图片的体积上限，超过就不收，避免有人往磁盘里塞大文件 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** 引用消息可能落在多远的记录里：先试 30 条，不够再翻 120 条 */
const QUOTE_WINDOWS = [30, 120]

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp'
}

const isHttpUrl = (value) => /^https?:\/\//i.test(String(value ?? ''))

function guessExt(nameOrUrl, contentType) {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime]
  const ext = path.extname(String(nameOrUrl ?? '').split('?')[0]).toLowerCase()
  return /^\.(png|jpg|jpeg|gif|webp|bmp)$/.test(ext) ? (ext === '.jpeg' ? '.jpg' : ext) : '.jpg'
}

const fmtTime = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false })

/** 「还剩 3 小时 12 分」 */
function leftText(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000))
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours > 0) return rest > 0 ? `${hours} 小时 ${rest} 分` : `${hours} 小时`
  return `${minutes} 分`
}

/**
 * 把被引用消息里的一个图片段变成字节。
 *
 * 两条路：
 *   1. 适配器已经把图落成临时文件 —— 直接读，最稳；
 *   2. 只有 http(s) 地址 —— 服务端去拉。
 *
 * 第 2 条是服务端发起的请求，而地址来自群消息（不可信输入），
 * 所以先过一遍公网判定，别让人拿这个当跳板去戳内网。
 */
async function segmentImage(segment) {
  const localPath = !isHttpUrl(segment?.file) ? String(segment?.file ?? '') : ''
  if (localPath) {
    try {
      if (fs.existsSync(localPath)) {
        const buffer = fs.readFileSync(localPath)
        if (buffer.length > 0 && buffer.length <= MAX_IMAGE_BYTES) {
          return { data: buffer, ext: guessExt(localPath), url: String(segment?.url ?? ''), mediaType: '' }
        }
        logger.warn(`[${pluginName}] 汤面图片体积不合适（${buffer.length} 字节），已跳过`)
        return null
      }
    } catch (error) {
      logger.debug(`[${pluginName}] 读取本地汤面图片失败：${error.message || error}`)
    }
  }

  const url = isHttpUrl(segment?.url) ? String(segment.url) : (isHttpUrl(segment?.file) ? String(segment.file) : '')
  if (!url) {
    const fieldNames = Object.keys(segment || {}).filter((k) => segment[k]).join(', ')
    logger.warn(`[${pluginName}] 汤面图片段里没有可用地址。该段带有的字段：${fieldNames || '(空)'}`)
    return null
  }

  if (!isPublicHttpUrl(url)) {
    logger.warn(`[${pluginName}] 汤面图片地址不是公网 http(s)，已跳过：${url}`)
    return null
  }

  try {
    const result = await getBuffer(url, 15000, MAX_IMAGE_BYTES)
    if (!result.ok || !result.buffer?.length) {
      logger.warn(`[${pluginName}] 下载汤面图片失败，HTTP ${result.status ?? '?'}`)
      return null
    }
    return {
      data: result.buffer,
      ext: guessExt(url, result.contentType),
      url,
      mediaType: String(result.contentType || '').split(';')[0].trim()
    }
  } catch (error) {
    logger.warn(`[${pluginName}] 下载汤面图片失败：${error.message || error}`)
    return null
  }
}

/** 把一条消息的段拆成「文字 + 图片段」 */
function splitSegments(quoted) {
  if (Array.isArray(quoted?.message)) return quoted.message
  if (typeof quoted?.raw_message === 'string' && quoted.raw_message.trim()) {
    return [{ type: 'text', text: quoted.raw_message }]
  }
  return []
}

export class soup extends plugin {
  constructor() {
    super({
      name: `[${pluginName}]海龟汤`,
      dsc: '海龟汤汤面暂存',
      event: 'message',
      // 负数优先级 = 在 loader 的升序队列里更早被检查，
      // 这样 #汤面 不会被 chat.js 的兜底抢走。
      priority: -3500,
      rule: [
        { reg: '^#汤面$', fnc: 'soup' },
        { reg: '^#删除汤面$', fnc: 'remove' }
      ]
    })
  }

  /** 记录 / 删除的资格：主人管理员恒可用，普通成员看开关（默认开） */
  canManage(e) {
    return Permission.isAdmin(e) || Cfg.getBool('soupAllowMember', true)
  }

  denied(e) {
    return e.reply(
      `只有主人和管理员才能记录 / 删除汤面（你当前是${Permission.roleLabel(e)}）。\n` +
      '要让普通成员也能用，去面板「插件配置 → DeepChat-plugin → 海龟汤」打开「允许普通成员使用」。'
    )
  }

  async soup(e) {
    if (!Cfg.getBool('soupEnable', true)) {
      return e.reply('汤面功能已在面板「海龟汤」里关闭。')
    }

    // 引用了消息 = 想记一条新的；没引用 = 想看当前这条
    const quoted = await findQuotedMessage(e, QUOTE_WINDOWS)
    if (quoted) return this.record(e, quoted)

    const meta = Soup.get(e)
    if (!meta) {
      const hours = Cfg.getNumber('soupExpireHours', 24, 1, 24 * 30)
      return e.reply(
        '这个会话还没有记录汤面。\n' +
        '记录方式：引用（长按 → 引用）那条汤面消息，再发 #汤面。\n' +
        `记好之后会保存 ${hours} 小时，期间随时发 #汤面 都能再看一次。`
      )
    }

    return this.show(e, meta)
  }

  async record(e, quoted) {
    if (!this.canManage(e)) return this.denied(e)

    const segments = splitSegments(quoted)
    const text = segments
      .filter((seg) => seg?.type === 'text')
      .map((seg) => seg.text ?? '')
      .join('')
      .trim()

    const max = Cfg.getNumber('soupMaxImages', 3, 0, 9)
    const imageSegments = max > 0 ? segments.filter((seg) => seg?.type === 'image').slice(0, max) : []

    const images = []
    for (const segment of imageSegments) {
      const image = await segmentImage(segment)
      if (image) images.push(image)
    }

    if (!text && images.length === 0) {
      return e.reply(
        '被引用的那条消息里没有能保存的文字或图片。\n' +
        (max <= 0 ? '（当前「汤面最多保存几张图」是 0，只收文字）' : '（图片也可能没下载下来，可以看日志确认）')
      )
    }

    const meta = Soup.save(e, { text, images })

    await e.reply(
      `已记录 ${meta.label} 的汤面` +
      (imageSegments.length > images.length ? `（${imageSegments.length} 张图里成功存下 ${images.length} 张）` : '') + '。\n' +
      `过期时间：${fmtTime(meta.expiresAt)}（约 ${leftText(meta.expiresAt - Date.now())}后）\n` +
      '之后发 #汤面 可以再看，发 #删除汤面 就删掉。'
    )

    // 顺手回一份图，让人确认存下来的正是这张
    for (const image of meta.images) {
      const buffer = Soup.imageBuffer(meta, image)
      if (buffer) await e.reply(buffer)
    }
    return true
  }

  async show(e, meta) {
    // 查看不设门槛：汤面就是放给大家看的
    const refreshed = Soup.touch(meta)
    const lines = [
      `【汤面】${meta.label}`,
      `记录：${fmtTime(meta.createdAt)} · 过期：${fmtTime(meta.expiresAt)}（还剩 ${leftText(meta.expiresAt - Date.now())}）`
    ]
    if (refreshed) lines.push('（面板开了「查看时重新计时」，过期时间已顺延）')
    if (meta.ownerName) lines.push(`记录人：${meta.ownerName}`)
    if (meta.text) lines.push('', meta.text)
    if (!meta.text && meta.images.length > 0) lines.push('', '（汤面是图片，见下面）')

    await e.reply(lines.join('\n'))

    for (const image of meta.images) {
      const buffer = Soup.imageBuffer(meta, image)
      if (buffer) { await e.reply(buffer); continue }
      if (image.url) await e.reply(`（有一张图在本地找不到了，原地址：${image.url}）`)
    }
    return true
  }

  async remove(e) {
    if (!Cfg.getBool('soupEnable', true)) {
      return e.reply('汤面功能已在面板「海龟汤」里关闭。')
    }
    if (!this.canManage(e)) return this.denied(e)

    const meta = Soup.remove(e)
    if (!meta) return e.reply('这个会话现在没有记录汤面，没什么可删的。')

    const parts = []
    if (meta.text) parts.push('文字')
    if (meta.images.length > 0) parts.push(`${meta.images.length} 张图`)
    return e.reply(`已删除 ${meta.label} 的汤面（${parts.join(' + ') || '空'}），临时文件也一起清掉了。`)
  }
}
