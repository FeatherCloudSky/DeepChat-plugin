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
import { findQuotedMessage } from '../model/utils.js'

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

/** 按文件头认图片类型 —— 适配器给的临时文件常叫 xxx.image，看扩展名会猜错 */
function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer)) return ''
  const head = buffer.subarray(0, 12)
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return '.png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return '.jpg'
  if (head.length >= 6 && head.subarray(0, 6).toString('latin1').startsWith('GIF8')) return '.gif'
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' &&
      head.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp'
  if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d) return '.bmp'
  return ''
}

/** 读本机图片：适配器给的可能是绝对路径、相对路径，或者只有一个文件名 */
function readLocalImage(raw) {
  const candidates = [raw]
  if (!path.isAbsolute(raw)) {
    candidates.push(path.resolve(process.cwd(), raw))
    candidates.push(path.resolve(process.cwd(), 'data', raw))
  }
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue
      const stat = fs.statSync(candidate)
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES) continue
      return fs.readFileSync(candidate)
    } catch (error) {
      // 换下一个候选路径继续试
    }
  }
  return null
}

/** 这些地址不给拉：云厂商的元数据服务，SSRF 最经典的目标 */
const BLOCKED_IMAGE_HOSTS = new Set([
  '100.100.100.200',            // 阿里云元数据
  '169.254.169.254',            // AWS / GCP / Azure 元数据
  'metadata.google.internal',
  'metadata.tencentyun.com'
])

/**
 * 汤面图必须真拉下来（要放 24 小时，只存 URL 撑不到），所以这里比
 * 「给模型看的图」宽一档：**允许 127.0.0.1 和内网地址**。
 *
 * 原因：不少适配器（OneBot 系的 NapCat、Lagrange 等）是拿本机的一个 HTTP
 * 端口供图的，地址就是 http://127.0.0.1:xxxx/xxx.jpg。按「只收公网」的规矩
 * 会把这整类图挡掉，表现就是「图片汤面存不下来」。
 *
 * 仍然挡：非 http(s) 协议、链路本地 / 组播地址、以及上面那几个元数据地址。
 */
function isFetchableImageUrl(value) {
  let url
  try {
    url = new URL(String(value ?? ''))
  } catch (error) {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false

  const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!host) return false
  if (BLOCKED_IMAGE_HOSTS.has(host)) return false
  if (/^169\.254\./.test(host)) return false        // IPv4 链路本地
  if (/^fe80:/i.test(host)) return false            // IPv6 链路本地
  if (/^ff/i.test(host)) return false               // 组播
  if (/^(0|22[4-9]|23\d|24\d|25[0-5])\./.test(host)) return false
  return true
}

/**
 * 把被引用消息里的一个图片段变成字节。
 *
 * 两条路：
 *   1. 适配器已经把图落成临时文件 —— 直接读，最稳；
 *   2. 只有 http(s) 地址 —— 服务端去拉。
 *
 * 第 2 条是服务端发起的请求，地址来自群消息，所以要过一遍
 * isFetchableImageUrl：本机 / 内网放行（适配器常这么供图），
 * 云元数据那类地址挡掉。
 */
async function segmentImage(segment) {
  const fileField = String(segment?.file ?? '')
  const urlField = String(segment?.url ?? '')
  const url = isHttpUrl(urlField) ? urlField : (isHttpUrl(fileField) ? fileField : '')
  const localRaw = fileField && !isHttpUrl(fileField) ? fileField : ''

  if (localRaw) {
    const buffer = readLocalImage(localRaw)
    if (buffer) {
      return {
        ok: true,
        data: buffer,
        ext: sniffImage(buffer) || guessExt(localRaw),
        url,
        mediaType: '',
        from: '本机文件'
      }
    }
  }

  if (!url) {
    const fieldNames = Object.keys(segment || {}).filter((k) => segment[k]).join(', ')
    logger.warn(`[${pluginName}] 汤面图片段里没有可用地址。该段带有的字段：${fieldNames || '(空)'}`)
    return { ok: false, reason: '这条消息里的图片既没有本机文件也没有下载地址' }
  }

  if (!isFetchableImageUrl(url)) {
    logger.warn(`[${pluginName}] 汤面图片地址被安全规则挡下，已跳过：${url}`)
    return { ok: false, reason: '图片地址指向的是云元数据之类的特殊地址，出于安全没有去拉' }
  }

  try {
    const result = await getBuffer(url, 15000, MAX_IMAGE_BYTES)
    if (!result.ok || !result.buffer?.length) {
      logger.warn(`[${pluginName}] 下载汤面图片失败，HTTP ${result.status ?? '?'}：${url}`)
      return { ok: false, reason: `图片下载失败（HTTP ${result.status ?? '?'}）` }
    }
    return {
      ok: true,
      data: result.buffer,
      ext: sniffImage(result.buffer) || guessExt(url, result.contentType),
      url,
      mediaType: String(result.contentType || '').split(';')[0].trim(),
      from: '下载'
    }
  } catch (error) {
    logger.warn(`[${pluginName}] 下载汤面图片失败：${error.message || error}`)
    return { ok: false, reason: '图片下载失败' }
  }
}

/**
 * 把存下来的图发出去。
 *
 * 首选 Buffer —— Yunzai 自己的渲染器就是这么发图的，是生态里最通用的一条路。
 * 万一这条不行，再退到 base64:// 字符串；都不行就把原地址发出来，
 * 至少让人知道图是什么，而不是什么都没有。
 */
async function sendImage(e, buffer, image) {
  try {
    await e.reply(buffer)
    return true
  } catch (error) {
    logger.warn(`[${pluginName}] 用 Buffer 发汤面图片失败，改用 base64 再试：${error.message || error}`)
  }
  try {
    await e.reply(`base64://${buffer.toString('base64')}`)
    return true
  } catch (error) {
    logger.warn(`[${pluginName}] base64 发汤面图片也失败：${error.message || error}`)
  }
  if (image?.url) await e.reply(`（这张图发不出来，原地址：${image.url}）`)
  return false
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
    const skipped = []
    for (const segment of imageSegments) {
      const result = await segmentImage(segment)
      if (result.ok) images.push(result)
      else skipped.push(result.reason)
    }

    if (!text && images.length === 0) {
      return e.reply(
        '被引用的那条消息里没有能保存的内容。\n' +
        (max <= 0
          ? '（当前「汤面最多保存几张图」是 0，只收文字）'
          : `（图片：${skipped[0] || '这条消息里没找到图片'}）`)
      )
    }

    const meta = Soup.save(e, { text, images })
    logger.mark(
      `[${pluginName}] 汤面已记录：文字 ${text.length} 字、图片 ${meta.images.length} 张` +
      (images.length > 0 ? `（图片来自${[...new Set(images.map((i) => i.from))].join('/')}）` : '')
    )

    // 哪张图没存下、为什么，直接说出来 —— 不然「图片汤面看不了」只能靠猜
    const note = skipped.length > 0 ? `（${skipped.length} 张图没存下：${skipped[0]}）` : ''
    await e.reply(
      `已记录 ${meta.label} 的汤面${note}。\n` +
      `过期时间：${fmtTime(meta.expiresAt)}（约 ${leftText(meta.expiresAt - Date.now())}后）\n` +
      '之后发 #汤面 可以再看，发 #删除汤面 就删掉。'
    )

    // 顺手回一份图，让人确认存下来的正是这张
    for (const image of meta.images) {
      const buffer = Soup.imageBuffer(meta, image)
      if (buffer) await sendImage(e, buffer, image)
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
      if (buffer) { await sendImage(e, buffer, image); continue }
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
