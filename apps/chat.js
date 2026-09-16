import fs from 'node:fs'
import path from 'node:path'
import Cfg from '../model/Cfg.js'
import Provider from '../model/Provider.js'
import Policy from '../model/Policy.js'
import Permission from '../model/Permission.js'
import { getBuffer } from '../model/http.js'
import { pluginName } from '../config/constant.js'
import { splitReply, sleep, isBlank, isPublicHttpUrl } from '../model/utils.js'

const CACHE_PREFIX = `${pluginName}:chat:`

/** 单张图片的体积上限，超过就放弃，避免把上下文撑爆 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value ?? ''))
}

function guessMime(nameOrUrl) {
  const clean = String(nameOrUrl ?? '').split('?')[0]
  return MIME_BY_EXT[path.extname(clean).toLowerCase()] || 'image/jpeg'
}

function replyWithRecall(e, replyPromise, seconds) {
  Promise.resolve(replyPromise).then((res) => {
    const messageId = res?.message_id
    if (!messageId || !seconds) return
    const target = e.group?.recallMsg ? e.group : (e.friend?.recallMsg ? e.friend : null)
    if (!target) return
    setTimeout(() => target.recallMsg(messageId).catch(() => {}), seconds * 1000)
  }).catch(() => {})
}

/** 把远端图片下载成 base64，避免部分服务商拉不到 QQ 的临时图片地址 */
async function downloadAsBase64(url, timeoutMs = 15000) {
  try {
    const result = await getBuffer(url, timeoutMs, MAX_IMAGE_BYTES)
    if (!result.ok) return null
    const buffer = result.buffer
    if (buffer.length === 0) return null
    const mediaType = String(result.contentType || guessMime(url)).split(';')[0].trim()
    return { type: 'image', data: buffer.toString('base64'), mediaType }
  } catch (error) {
    logger.debug(`[${pluginName}] 下载图片失败或超限：${error.message || error}`)
    return null
  }
}

/** 把一个 QQ 图片消息段转成内部图片分段 */
async function segmentToImagePart(segment) {
  const rawUrl = isHttpUrl(segment?.url) ? segment.url : (isHttpUrl(segment?.file) ? segment.file : '')
  const localFile = !isHttpUrl(segment?.file) ? segment?.file : ''

  // 本地临时文件优先：最稳，不依赖服务商能不能访问 QQ 的图片地址
  if (localFile && fs.existsSync(localFile)) {
    try {
      const buffer = fs.readFileSync(localFile)
      if (buffer.length > 0 && buffer.length <= MAX_IMAGE_BYTES) {
        return { type: 'image', data: buffer.toString('base64'), mediaType: guessMime(localFile) }
      }
    } catch {
      // 读不到就继续尝试 URL
    }
  }

  if (rawUrl) {
    if (Cfg.getBool('imageDownload', false)) {
      // 图片地址来自群消息，是不可信输入。服务端主动去下载之前先挡住
      // 非公网地址，避免被当成 SSRF 跳板。挡下来的仍然按 URL 透传给服务商。
      if (isPublicHttpUrl(rawUrl)) {
        const downloaded = await downloadAsBase64(rawUrl)
        if (downloaded) return downloaded
      } else {
        logger.warn(`[${pluginName}] 图片地址不是公网 http(s)，已跳过下载、仅透传 URL：${rawUrl}`)
      }
    }
    return { type: 'image', url: rawUrl }
  }

  // 到这儿说明这段既没有可读的本地文件，也没有 http(s) 地址。
  // 只打印「有哪些字段」，不打印字段值（可能很长）——用来定位适配器给了什么。
  const fieldNames = Object.keys(segment || {})
    .filter((k) => segment[k] !== undefined && segment[k] !== null && segment[k] !== '')
    .join(', ')
  logger.warn(`[${pluginName}] 图片段里没有可用地址。该段带有的字段：${fieldNames || '(空)'}`)
  return null
}

/** 取出本条消息里的图片（受 imageMaxCount 限制） */
function collectImageSegments(e) {
  const max = Cfg.getNumber('imageMaxCount', 3, 0, 10)
  if (max <= 0) return []
  const segments = Array.isArray(e.message) ? e.message : []
  const images = []
  for (const segment of segments) {
    if (segment?.type !== 'image') continue
    images.push(segment)
    if (images.length >= max) break
  }
  return images
}

/** 把文本消息统一成「发送者前缀 + 内容」 */
function decorateUserText(e, content) {
  const sender = e.sender || {}
  if (e.isGroup) {
    const isAdmin = sender.role === 'admin' || sender.role === 'owner'
    const roleInfo = isAdmin ? (sender.role === 'owner' ? '(群主)' : '(管理员)') : '(群员)'
    const titleInfo = sender.title ? `[${sender.title}]` : ''
    return `${roleInfo}${titleInfo} | ${sender.card || sender.nickname || e.user_id}: ${content}`
  }
  return `${sender.nickname || e.user_id}: ${content}`
}

export default class DeepChat extends plugin {
  constructor() {
    super({
      name: 'DeepChat',
      dsc: '接入 OpenAI / Anthropic 兼容 API 的拟人聊天',
      event: 'message',
      priority: 1000,
      rule: [
        // 只匹配「#chat」后面确实跟了内容的情况，裸 #chat 走帮助提示
        { reg: '^#chat(\\s|$)', fnc: 'chatCommand' },
        { reg: '^#结束对话$', fnc: 'endConversation' },
        { reg: '^#结束全部对话$', fnc: 'endAllConversations' }
      ]
    })
    this.redisKeyPrefix = CACHE_PREFIX
  }

  // ---------------------------------------------------------------- 主动命令

  async chatCommand(e) {
    const content = String(e.msg ?? '').replace(/^#chat\s*/, '').trim()
    if (!content && collectImageSegments(e).length === 0) {
      return e.reply('请在 #chat 后面跟上内容，例如：#chat 你好')
    }
    if (!Policy.resolveEnabled(e)) {
      return e.reply('本会话的 AI 对话已关闭。发送 #chat开 可以启用。')
    }
    if (Cfg.getBool('thinking', false)) {
      replyWithRecall(e, e.reply('我正在思考如何回复你，请稍候', true), 30)
    }
    return this.processChat(e, content, 'active')
  }

  async endConversation(e) {
    try {
      await redis.del(this.getCacheKey(e))
      return e.reply('已结束当前对话，相关上下文已被清除。')
    } catch (error) {
      logger.error(`[${pluginName}] 结束对话失败：${error.message || error}`)
      return e.reply('结束对话失败，请稍后再试。')
    }
  }

  async endAllConversations(e) {
    if (!Permission.isMaster(e)) return e.reply('只有主人才能结束全部对话。')
    try {
      const keys = await redis.keys(`${this.redisKeyPrefix}*`)
      if (keys.length > 0) await redis.del(keys)
      return e.reply(`已结束全部对话，共清除 ${keys.length} 条上下文。`)
    } catch (error) {
      logger.error(`[${pluginName}] 结束全部对话失败：${error.message || error}`)
      return e.reply('结束全部对话失败，请稍后再试。')
    }
  }

  // ---------------------------------------------------------------- 被动拦截

  /**
   * Yunzai 会在正则匹配之前对每条消息调用 accept()。
   * 返回 false 表示「我不管这条消息」。
   */
  async accept(e) {
    // 注意：纯图片消息的 e.msg 是空字符串，不能因为「没有文字」就把它拦掉
    if (typeof e.msg !== 'string') return false
    const msg = e.msg.trim()
    if (msg.startsWith('#')) return false
    if (String(e.user_id) === String(e.self_id)) return false

    const hasImage = collectImageSegments(e).length > 0
    if (!msg && !hasImage) return false

    if (!Policy.resolveEnabled(e)) return false

    // 私聊
    if (!e.isGroup) {
      if (Cfg.getBool('thinking', false)) {
        replyWithRecall(e, e.reply('我正在思考如何回复你，请稍候', true), 30)
      }
      return this.processChat(e, msg, 'active')
    }

    // 群聊里被艾特
    const isAtMe = e.atme || e.message?.some((item) => item.type === 'at' && String(item.qq) === String(e.self_id))
    if (isAtMe && Cfg.getBool('enableAt', true)) {
      const nickname = e.bot?.info?.nickname
      let content = nickname
        ? msg.replace(new RegExp(`^@${nickname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '').trim()
        : msg.replace(/^@\S+\s*/, '').trim()
      if (!content && Array.isArray(e.message)) {
        content = e.message.filter((seg) => seg.type === 'text').map((seg) => seg.text).join('').trim()
      }
      if (!content && collectImageSegments(e).length === 0) return false
      if (Cfg.getBool('thinking', false)) {
        replyWithRecall(e, e.reply('我正在思考如何回复你，请稍候', true), 30)
      }
      // 被艾特 = 主动提问，不受伪人黑白名单限制
      return this.processChat(e, content, 'active')
    }

    // 命中 AI 名称或触发关键词 = 明确在叫它，按【主动模式】回复：
    // 用主动模式的温度 / token 上限，且不受伪人黑白名单限制
    // （伪人黑名单是给「随机接话」准备的，不该让点名也失灵）
    const trigger = this.matchTrigger(msg)
    if (trigger) {
      logger.info(
        `[${pluginName}] 命中${trigger.kind}「${trigger.text}」，主动回复：` +
        `群(${e.group_id}) 用户(${e.user_id})`
      )
      if (Cfg.getBool('thinking', false)) {
        replyWithRecall(e, e.reply('我正在思考如何回复你，请稍候', true), 30)
      }
      return this.processChat(e, msg, 'active')
    }

    // 以下才是伪人模式：随机接话，受黑白名单限制
    if (!Policy.shouldPseudoTrigger(e)) return false
    if (!Cfg.getBool('enablePseudoHuman', true)) return false

    const probability = Cfg.getNumber('pseudoHumanProbability', 3, 0, 100)
    if (Math.random() * 100 >= probability) return false

    // 可选的随机延迟，让插话更像真人
    const delayRange = String(Cfg.get('delay', '')).split('-').map((n) => Number(n))
    if (delayRange.length === 2 && delayRange.every((n) => Number.isFinite(n)) && delayRange[1] > delayRange[0]) {
      await sleep(Math.random() * (delayRange[1] - delayRange[0]) + delayRange[0])
    }

    logger.info(`[${pluginName}] 概率命中伪人模式：群(${e.group_id}) 用户(${e.user_id})`)
    return this.processChat(e, msg, 'pseudo')
  }

  /**
   * 判断这条消息有没有「明确叫到 AI」。命中返回 { kind, text }，否则 null。
   *
   *   名称   —— 默认按关键词包含匹配（不需要 @），开启 aiNameRegex 后按正则
   *   关键词 —— 至多 MAX_KEYWORDS 个，纯字面包含匹配，不做正则解释
   *
   * 两者都算作明确呼叫，走主动模式。
   */
  matchTrigger(msg) {
    const aiName = String(Cfg.get('aiName', '')).trim()
    if (aiName && Cfg.getBool('enableName', true)) {
      if (Policy.matchAiName(msg, aiName, Cfg.getBool('aiNameRegex', false))) {
        return { kind: '名称', text: aiName }
      }
    }

    const keyword = Policy.matchAiKeyword(msg)
    if (keyword) return { kind: '关键词', text: keyword }

    return null
  }

  // ---------------------------------------------------------------- 对话主体

  async processChat(e, content, interactionType = 'active') {
    try {
      const images = await this.buildImageParts(e)
      const { messages, cacheKey } = await this.getContextWithHistory(e, content, interactionType, images)

      const request = {
        messages,
        model: Cfg.get('model', '') || undefined,
        temperature: Cfg.get('temperature', 1),
        maxTokens: Cfg.get('maxTokens', 512)
      }

      if (interactionType === 'pseudo') {
        request.temperature = Cfg.get('pseudoTemperature', 1.5)
        request.maxTokens = Cfg.get('pseudoMaxTokens', 128)
      }

      const answer = await Provider.chat(request)

      if (!answer) {
        if (interactionType === 'active') return e.reply('AI 响应失败，请稍后再试或检查插件配置。')
        logger.info(`[${pluginName}] 伪人模式响应为空，静默跳过`)
        return false
      }

      await this.saveToCache(e, cacheKey, messages, answer)

      const segments = Cfg.getBool('splitReply', true)
        ? splitReply(answer, {
            maxSegments: Cfg.getNumber('maxSplitSegments', 5, 1, 50),
            maxLength: Cfg.getNumber('noSplitOverLength', 500, 1, 100000)
          })
        : [answer.trim()]

      const delayPerChar = Cfg.getNumber('replyDelayPerChar', 150, 0, 5000)
      const delayMax = Cfg.getNumber('replyDelayMaxMs', 2000, 0, 60000)

      for (const segment of segments) {
        if (!segment) continue
        await e.reply(segment)
        if (delayPerChar > 0 && delayMax > 0) {
          await sleep(Math.min(segment.length * delayPerChar, delayMax))
        }
      }
      return true
    } catch (error) {
      logger.error(`[${pluginName}] 聊天处理异常（${interactionType}）：${error.message || error}`)
      if (interactionType === 'active') return e.reply(`处理失败：${error.message || '未知错误'}`)
      return false
    }
  }

  /** 按当前模型的能力决定要不要把图片带上；不支持时退化成文字标记 */
  async buildImageParts(e) {
    const segments = collectImageSegments(e)
    if (segments.length === 0) return []

    const model = Cfg.get('model', '')
    if (!Cfg.visionFor(model)) {
      logger.info(
        `[${pluginName}] 这条消息带 ${segments.length} 张图，但模型「${model || '(未配置)'}」没有开启图片输入，` +
        '已降级成 [图片] 文字。可在面板「模型能力 → 逐模型图片能力」里为它打开。'
      )
      return []
    }

    const parts = []
    for (const segment of segments) {
      const part = await segmentToImagePart(segment)
      if (part) parts.push(part)
    }

    logger.info(
      `[${pluginName}] 图片输入：模型「${model}」已开启图片能力，` +
      `识别到 ${segments.length} 张，成功转换 ${parts.length} 张` +
      `（${parts.map((p) => (p.data ? 'base64' : 'URL')).join('/') || '无'}）`
    )
    return parts
  }

  // ---------------------------------------------------------------- 上下文

  getCacheKey(e) {
    return `${this.redisKeyPrefix}${e.isGroup ? `group:${e.group_id}` : `private:${e.user_id}`}`
  }

  async getCache(key) {
    try {
      const raw = await redis.get(key)
      return raw ? JSON.parse(raw) : null
    } catch (error) {
      logger.error(`[${pluginName}] 读取上下文失败：${error.message || error}`)
      return null
    }
  }

  /**
   * 写回上下文。
   * 特意把图片转成纯文本标记再缓存：base64 图片留在 Redis 里既占内存又没意义，
   * 图片只需要在「当前这一轮」发给模型。historyCount 为 0 时干脆不缓存。
   */
  async saveToCache(e, key, messages, answer) {
    const maxContextLength = Cfg.getNumber('maxContextLength', 25, 1, 200)
    const expireMinutes = Cfg.getNumber('cacheExpireMinutes', 60, 1, 10080)
    const imageMark = Cfg.get('imageHistoryMark', '[图片]')

    const system = messages.filter((m) => m.role === 'system')
    const dialog = messages.filter((m) => m.role !== 'system')
    const trimmed = dialog.slice(-maxContextLength)

    const payload = [
      ...system,
      ...trimmed,
      { role: 'assistant', content: answer }
    ].map((message) => ({
      role: message.role,
      content: Provider.partsToPlainText
        ? Provider.partsToPlainText(message.content, imageMark)
        : String(message.content ?? '')
    }))

    try {
      await redis.set(key, JSON.stringify(payload), { EX: expireMinutes * 60 })
    } catch (error) {
      logger.error(`[${pluginName}] 写入上下文失败：${error.message || error}`)
    }
  }

  /** 首次对话时，用最近若干条群聊/私聊记录给模型一点语感 */
  async getChatHistory(e) {
    const historyCount = Cfg.getNumber('historyCount', 7, 0, 50)
    if (historyCount <= 0) return []

    const imageMark = Cfg.get('imageHistoryMark', '[图片]')
    try {
      const fetchCount = Math.min(historyCount + 5, 50)
      const raw = e.isGroup
        ? await e.group.getChatHistory(0, fetchCount)
        : await e.friend.getChatHistory(0, fetchCount)

      return (raw || [])
        .map((msg) => this.formatHistoryMessage(e, msg, imageMark))
        .filter(Boolean)
        .slice(-historyCount)
    } catch (error) {
      logger.error(`[${pluginName}] 获取聊天记录失败：${error.message || error}`)
      return []
    }
  }

  formatHistoryMessage(e, msg, imageMark) {
    if (!msg || !Array.isArray(msg.message) || isBlank(msg.raw_message)) return null

    const isBot = String(msg.user_id) === String(e.self_id)
    const role = isBot ? 'assistant' : 'user'

    let content = msg.message
      .map((seg) => {
        if (seg.type === 'text') return seg.text
        if (seg.type === 'image') return imageMark
        if (seg.type === 'face') return '[表情]'
        if (seg.type === 'at') return `@${seg.qq}`
        return `[${seg.type}]`
      })
      .join('')
      .trim()

    if (!content) return null

    if (role === 'user') {
      const sender = msg.sender || {}
      if (e.isGroup) {
        const isAdmin = sender.role === 'admin' || sender.role === 'owner'
        const roleInfo = isAdmin ? (sender.role === 'owner' ? '(群主)' : '(管理员)') : '(群员)'
        const titleInfo = sender.title ? `[${sender.title}]` : ''
        content = `${roleInfo}${titleInfo} | ${sender.card || sender.nickname || msg.user_id}: ${content}`
      } else {
        content = `${sender.nickname || msg.user_id}: ${content}`
      }
    }

    return { role, content }
  }

  buildSystemMessage(e, interactionType) {
    const aiName = Cfg.get('aiName', 'AI助手')
    const userName = e.bot?.info?.nickname || '机器人'

    const lines = [`机器人名字: ${userName}`, `你的名字: ${aiName}`]

    if (e.isGroup) {
      lines.push('当前在群聊中。', `群号: ${e.group_id}`, `群名: ${e.group_name}`)
      if (interactionType === 'pseudo') {
        lines.push(
          '你正在以伪人模式参与群聊。回复要非常简短、口语化，模仿群友的风格，可以发表情或简短附和。',
          '不要表现得像 AI 助手，不要在回复前加名字前缀，不要使用 CQ 码或任何格式化标记。',
          '如果你觉得这条消息不需要回应，只输出 <EMPTY>。'
        )
      } else {
        lines.push(
          '你正在群聊中被直接提问或互动。请结合上下文和聊天记录，清晰自然地回复。优先使用中文。',
          '不要在回复前加名字前缀，不要使用 CQ 码或任何格式化标记。'
        )
      }
    } else {
      lines.push('当前在私聊中。', `用户: ${e.sender?.nickname || e.user_id}`, `用户QQ: ${e.user_id}`)
      lines.push(
        '你需要像真人一样自然地回复。结合用户发言和聊天记录回应，优先使用中文。',
        '不要在回复前加名字前缀，不要使用 CQ 码或任何格式化标记。'
      )
    }

    const prompt = Cfg.get('prompt', '')
    if (prompt) lines.push('', '以下是你的人设设定：', prompt)

    return { role: 'system', content: lines.join('\n') }
  }

  async getContextWithHistory(e, content, interactionType, images) {
    const cacheKey = this.getCacheKey(e)
    let messages = await this.getCache(cacheKey)

    if (!Array.isArray(messages) || messages.length === 0) {
      messages = [this.buildSystemMessage(e, interactionType)]
      const history = await this.getChatHistory(e)
      messages = messages.concat(history)
    }

    const decorated = decorateUserText(e, content)
    let userContent = decorated

    if (images.length > 0) {
      userContent = [{ type: 'text', text: decorated }, ...images]
    } else if (collectImageSegments(e).length > 0) {
      // 模型不支持图片，但至少要让它知道有图
      userContent = `${decorated} ${Cfg.get('imageHistoryMark', '[图片]')}`.trim()
    }

    // 同一句话可能因为重试被重复追加，这里做一次精确去重
    const last = messages[messages.length - 1]
    if (last && last.role === 'user' && typeof last.content === 'string' && last.content === userContent) {
      messages.pop()
    }

    messages.push({ role: 'user', content: userContent })

    return { messages, cacheKey }
  }
}
