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
import path from 'node:path'
import Soup from '../model/Soup.js'
import Cfg from '../model/Cfg.js'
import Permission from '../model/Permission.js'
import { getBuffer } from '../model/http.js'
import { replyImage } from '../model/message.js'
import { readImageSize, isOverLimit, shrinkImage } from '../model/image.js'
import { pluginName } from '../config/constant.js'
import { findQuotedMessage } from '../model/utils.js'
import { readTrustedImage } from '../model/safepath.js'
import { sniffImageType } from '../model/sniff.js'
import { downloadConcurrency, withSlot } from '../model/concurrency.js'
import { redactUrl } from '../model/net.js'

/**
 * 源图硬上限：超过这个数就不拉了，免得内存被顶爆。
 * 拉回来之后按面板配置的上限（默认 20MB / 10000px）缩，缩不动才放弃。
 */
const SOURCE_HARD_CAP = 32 * 1024 * 1024

/** 引用消息可能落在多远的记录里：先试 30 条，不够再翻 120 条 */
const QUOTE_WINDOWS = [30, 120]

const isHttpUrl = (value) => /^https?:\/\//i.test(String(value ?? ''))

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
const sniffImage = sniffImageType

/** 允许访问的「本机/内网」地址白名单（适配器自建 HTTP 端口这类） */
function privateHostAllowList() {
  return Cfg.getIdList('privateHostAllowList')
}

/**
 * 读本机图片：适配器给的可能是绝对路径、相对路径，或者只有一个文件名。
 * 只认受信任目录里的文件，而且内容必须真的是图片。
 */
function readLocalImage(raw) {
  const candidates = [raw]
  if (!path.isAbsolute(raw)) {
    candidates.push(path.resolve(process.cwd(), raw))
    candidates.push(path.resolve(process.cwd(), 'data', raw))
  }
  try {
    return readTrustedImage(candidates, {
      maxBytes: SOURCE_HARD_CAP,
      extraRoots: Cfg.getIdList('localFileRoots')
    })
  } catch (error) {
    logger.warn(`[${pluginName}] 汤面图片的本地文件不可用：${error.message || error}`)
    return null
  }
}

/**
 * 把被引用消息里的一个图片段变成字节。
 *
 * 两条路：
 *   1. 适配器已经把图落成临时文件 —— 直接读（限受信任目录）；
 *   2. 只有 http(s) 地址 —— 服务端去拉。
 *
 * 第 2 条是服务端发起的请求，地址来自群消息：
 * 只允许公网地址，域名先解析、再核对接回来的每个 IP、连接钉在审核过的地址上。
 * 适配器本机端口这类需求，用面板里的白名单显式放行，不要放宽这里的规则。
 */
async function segmentImage(segment) {
  // 兼容两种段结构：Yunzai 的 { file, url } 与 OneBot v11 的 { data: { file, url } }
  const data = segment?.data && typeof segment.data === 'object' ? segment.data : null
  const fileField = String(segment?.file ?? data?.file ?? '')
  const urlField = String(segment?.url ?? data?.url ?? '')
  const url = isHttpUrl(urlField) ? urlField : (isHttpUrl(fileField) ? fileField : '')
  const localRaw = fileField && !isHttpUrl(fileField) ? fileField : ''

  if (localRaw) {
    const local = readLocalImage(localRaw)
    if (local) {
      return {
        ok: true,
        data: local.buffer,
        ext: local.ext,
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

  try {
    const result = await withSlot('download', downloadConcurrency(),
      () => getBuffer(url, 15000, SOURCE_HARD_CAP, {
        allowPrivate: false,
        allowLoopback: false,
        allowHosts: privateHostAllowList()
      }))
    if (!result.ok || !result.buffer?.length) {
      logger.warn(`[${pluginName}] 下载汤面图片失败，HTTP ${result.status ?? '?'}：${redactUrl(url)}`)
      return { ok: false, reason: `图片下载失败（HTTP ${result.status ?? '?'}）` }
    }
    // 非图片内容不保存、不进入回复流程：只给提示等于没隔离
    const ext = sniffImage(result.buffer)
    if (!ext) {
      logger.warn(`[${pluginName}] 汤面图片地址返回的不是图片，已拒绝：${redactUrl(url)}`)
      return { ok: false, reason: '这个地址返回的内容不是图片，已拒绝保存' }
    }
    return {
      ok: true,
      data: result.buffer,
      ext,
      url,
      mediaType: String(result.contentType || '').split(';')[0].trim(),
      from: '下载'
    }
  } catch (error) {
    logger.warn(`[${pluginName}] 下载汤面图片失败：${error.message || error}`)
    return { ok: false, reason: error?.name === 'BlockedTargetError' ? '这个图片地址指向非公网范围，已拒绝' : '图片下载失败' }
  }
}

/** 发汤面图：走统一的图片段写法；发不出去就说清楚，别静默 */
async function sendImage(e, buffer, image) {
  const sent = await replyImage(e, buffer)
  if (sent.ok) return true
  logger.warn(`[${pluginName}] 汤面图发送失败：${sent.error || '未知原因'}`)
  await e.reply(
    image?.url
      ? `（这张图发不出去：${sent.error || '被协议端拒绝'}。原地址含临时签名，已隐藏）`
      : `（这张图发不出去：${sent.error || '被协议端拒绝'}。如果别的插件发图也失败，多半是账号被限制发图了）`
  )
  return false
}

/** 单张图的体积上限（字节） */
function maxImageBytes() {
  return Cfg.getNumber('soupMaxImageMB', 20, 1, 256) * 1024 * 1024
}

/** 单边像素上限 */
function maxImageSide() {
  return Cfg.getNumber('soupMaxImageSide', 10000, 100, 50000)
}

/** 单张图的总像素上限：解码炸弹的常见形态是「字节很小、尺寸极大」 */
function maxImagePixels() {
  return Cfg.getNumber('soupMaxPixels', 40, 1, 400) * 1000000
}

/**
 * 按面板配置卡一下图：超了就自动缩小，缩不动才放回一个「为什么」。
 * @returns {Promise<{ok: boolean, image?: object, shrunk?: boolean, reason?: string}>}
 */
async function applyImageLimits(e, image) {
  const maxBytes = maxImageBytes()
  const maxSide = maxImageSide()
  const maxPixels = maxImagePixels()
  const size = readImageSize(image.data)

  // 总像素超预算的图**不交给渲染器**：缩图本身就要先解码，
  // 把一个 50000×50000 的图丢进去，等于让「限制」自己变成攻击面。
  if (size?.width && size?.height && size.width * size.height > maxPixels) {
    return {
      ok: false,
      reason: `图片像素超过上限（${size.width}×${size.height}，上限 ${Math.round(maxPixels / 1000000)} 百万像素）`
    }
  }

  if (!isOverLimit(size, image.data.length, { maxSide, maxBytes })) {
    return { ok: true, image, shrunk: false }
  }

  const describe = size?.width
    ? `${size.width}×${size.height}、${(image.data.length / 1024 / 1024).toFixed(1)}MB`
    : `${(image.data.length / 1024 / 1024).toFixed(1)}MB`

  const shrunkImage = await shrinkImage(e, image.data, size, { maxSide, maxBytes })
  if (!shrunkImage) {
    return {
      ok: false,
      reason: `图片超过上限（${describe}，上限 ${maxSide}px / ${Cfg.getNumber('soupMaxImageMB', 20, 1, 256)}MB）`
    }
  }

  return {
    ok: true,
    shrunk: true,
    image: { ...image, data: shrunkImage.data, ext: shrunkImage.ext, from: `${image.from}+缩放` }
  }
}

/** 存下来的字节看着不像图片时，把这件事说出来，别让人对着空白猜 */
function describeSuspectFormat(buffer) {
  return `（这张图存下来的内容不像是图片：${buffer.length} 字节。多半是当初没下载成功，重新记录一次汤面试试）`
}

/**
 * 有些适配器的聊天记录里，message 是一串 CQ 码而不是分段数组。
 * 这种字符串直接当正文存下来，就会出现「明明是图片，却存成一段文字」。
 */
function parseCqString(raw) {
  const unescape = (value) => String(value ?? '')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&')

  const segments = []
  const pattern = /\[CQ:([a-zA-Z0-9_]+)((?:,[^\]]*)?)\]/g
  let last = 0
  let match

  while ((match = pattern.exec(raw)) !== null) {
    const plain = raw.slice(last, match.index)
    if (plain) segments.push({ type: 'text', text: plain })
    last = match.index + match[0].length

    const type = match[1].toLowerCase()
    const params = {}
    for (const pair of match[2].split(',').filter(Boolean)) {
      const at = pair.indexOf('=')
      if (at > 0) params[pair.slice(0, at)] = unescape(pair.slice(at + 1))
    }
    segments.push({ type, ...params })
  }

  const tail = raw.slice(last)
  if (tail) segments.push({ type: 'text', text: tail })
  return segments
}

/** 按段类型取文字：兼容 Yunzai 的 { text } 与 OneBot v11 的 { data: { text } } */
function textOfSegment(segment) {
  if (typeof segment?.text === 'string') return segment.text
  if (segment?.data && typeof segment.data === 'object' && typeof segment.data.text === 'string') {
    return segment.data.text
  }
  return ''
}

/** 把一条消息的段拆成「文字 + 图片段」 */
function splitSegments(quoted) {
  if (Array.isArray(quoted?.message)) return quoted.message
  if (typeof quoted?.message === 'string' && quoted.message.trim()) return parseCqString(quoted.message)
  if (typeof quoted?.raw_message === 'string' && quoted.raw_message.trim()) {
    return parseCqString(quoted.raw_message)
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
        // 容忍全角 ＃ 和前后空格 —— 手机上打字很容易多一个空格，
        // 而「发了没反应」十有八九就是这种看不见的差异
        { reg: '^[#＃]\\s*汤面\\s*$', fnc: 'soup' },
        { reg: '^[#＃]\\s*删除汤面\\s*$', fnc: 'remove' }
      ]
    })
  }

  /**
   * 每条消息都先过这里。返回 false = 「我不认领这条消息」，消息继续往下走。
   *
   * 这里只做一件事：消息里提到「汤面」就记一条日志（**不记正文**）。
   * 记正文会把群友的聊天内容抄进日志文件，而日志的保留期和访问权限
   * 都不受这个插件控制 —— 为了排障不值得。
   */
  async accept(e) {
    try {
      const msg = String(e?.msg ?? '')
      if (msg.includes('汤面')) {
        logger.info(
          `[${pluginName}] 收到含「汤面」的消息（${msg.length} 字，内容不记录）` +
          `（会话 ${e?.isGroup ? `群 ${e.group_id}` : `私聊 ${e?.user_id}`}）`
        )
      }
    } catch (error) {
      // 只是日志，绝不能因为它影响消息流转
    }
    return false
  }

  /** 记录 / 删除的资格：主人管理员恒可用，普通成员默认不可用（面板可放开） */
  canManage(e) {
    return Permission.isAdmin(e) || Cfg.getBool('soupAllowMember', false)
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
      .map(textOfSegment)
      .join('')
      .trim()

    // 出问题时最想知道的就是「插件到底看到了什么」，直接写进日志
    logger.info(
      `[${pluginName}] 被引用的消息形态：message=` +
      `${Array.isArray(quoted?.message) ? `数组(${quoted.message.length})` : typeof quoted?.message}、` +
      `段类型=${segments.map((seg) => seg?.type || '?').join('/') || '无'}`
    )

    const max = Cfg.getNumber('soupMaxImages', 3, 0, 9)
    const imageSegments = max > 0 ? segments.filter((seg) => seg?.type === 'image').slice(0, max) : []

    const images = []
    const skipped = []
    let shrunkCount = 0
    for (const segment of imageSegments) {
      const result = await segmentImage(segment)
      if (!result.ok) { skipped.push(result.reason); continue }
      const limited = await applyImageLimits(e, result)
      if (!limited.ok) { skipped.push(limited.reason); continue }
      if (limited.shrunk) shrunkCount++
      images.push(limited.image)
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
    const suspect = images.filter((img) => !sniffImage(img.data)).length
    logger.mark(
      `[${pluginName}] 汤面已记录：文字 ${text.length} 字、图片 ${meta.images.length} 张` +
      (images.length > 0
        ? `（来自${[...new Set(images.map((i) => i.from))].join('/')}；` +
          `${images.map((i) => `${i.data.length} 字节 ${i.ext}`).join('、')}）`
        : '')
    )

    // 哪张图没存下、为什么，直接说出来 —— 不然「图片汤面看不了」只能靠猜
    const notes = []
    if (skipped.length > 0) notes.push(`${skipped.length} 张图没存下：${skipped[0]}`)
    if (shrunkCount > 0) notes.push(`${shrunkCount} 张图超过上限，已自动缩小`)
    if (suspect > 0) notes.push(`${suspect} 张图的字节不像是图片，可能没下到真图`)
    const note = notes.length > 0 ? `（${notes.join('；')}）` : ''
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
      if (!buffer) {
        if (image.url) await e.reply('（有一张图在本地找不到了；原地址含临时签名，已隐藏）')
        continue
      }
      // 先把「这字节不像图片」说出来：万一图发不出去，至少还有个线索
      if (!sniffImage(buffer)) await e.reply(describeSuspectFormat(buffer))
      await sendImage(e, buffer, image)
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
