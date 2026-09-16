/**
 * API 适配层：同时支持 OpenAI 兼容与 Anthropic 兼容两种协议。
 *
 * 只用 Node 18+ 内置的 fetch，不引入 openai / axios 等依赖，
 * 因此插件克隆下来即可用，不需要额外安装任何包。
 *
 * OpenAI 兼容  : POST {base}/chat/completions   Authorization: Bearer <key>
 * Anthropic 兼容: POST {base}/messages           x-api-key: <key>
 *                                                 anthropic-version: <version>
 */
import Cfg from './Cfg.js'
import { pluginName } from '../config/constant.js'
import { pickApiKey, isBlank } from './utils.js'
import { postJson, transportName } from './http.js'

/** 未填写 apiUrl 时，按协议走官方默认地址 */
const PROVIDER_DEFAULTS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1'
}

const PROVIDER_DEFAULT_MODEL = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-sonnet-latest'
}

/**
 * 图片细节级别，对应 OpenAI 兼容协议里 image_url.detail。
 * 留空 = 不发送这个字段（最保险：不是所有兼容服务商都认它）。
 * 参考 DeepSeek 文档：low 会先把图缩到 512×512 再推理，更快更省 token；
 * high / original 保留原图；auto 由服务商决定（目前等价 original）。
 */
const IMAGE_DETAIL_LEVELS = ['low', 'high', 'original', 'auto']

export function normalizeImageDetail(value) {
  const level = String(value ?? '').trim().toLowerCase()
  return IMAGE_DETAIL_LEVELS.includes(level) ? level : ''
}

function normalizeBase(url) {
  return String(url ?? '').trim().replace(/\/+$/, '')
}

/**
 * 解析出本次请求要用的协议与地址。
 * 与参考实现的关键差别：apiUrl 为空时，会按所选协议回落到官方地址，
 * 而不是把空字符串透传下去（那会导致请求悄悄打到别的服务商）。
 */
export function resolveEndpoint() {
  const provider = Cfg.getBool('useAnthropic', false) ? 'anthropic' : 'openai'
  const configured = normalizeBase(Cfg.get('apiUrl', ''))
  return {
    provider,
    base: configured || PROVIDER_DEFAULTS[provider],
    fallback: isBlank(Cfg.get('apiUrl', ''))
  }
}

/** OpenAI 的 message.content 可能是字符串，也可能是多模态数组 */
function extractOpenAIText(data) {
  const choice = data?.choices?.[0]
  if (!choice) return ''
  const content = choice.message?.content ?? choice.text
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : (part?.text ?? '')))
      .join('')
  }
  return ''
}

/** Anthropic 返回的是 content 区块数组，只取 text 块 */
function extractAnthropicText(data) {
  if (typeof data?.content === 'string') return data.content
  if (!Array.isArray(data?.content)) return ''
  return data.content
    .filter((block) => block && (block.type === 'text' || typeof block.text === 'string'))
    .map((block) => block.text ?? '')
    .join('')
}

function extractErrorMessage(result) {
  const data = result?.data
  if (data?.error?.message) return data.error.message
  if (typeof data?.error === 'string') return data.error
  if (data?.message) return data.message
  return String(result?.text ?? '').slice(0, 300) || `HTTP ${result?.status}`
}

/**
 * 内部消息的 content 有两种形态：
 *   - 字符串："你好"
 *   - 分段数组：[{ type:'text', text:'看图' }, { type:'image', url|data, mediaType }]
 * 下面两个函数把它翻译成各家协议要求的形状。
 */
function isParts(content) {
  return Array.isArray(content)
}

/** 把分段内容压成纯文本（用于只支持文本的模型 / 历史记录） */
export function partsToPlainText(content, imageMark = '[图片]') {
  if (!isParts(content)) return String(content ?? '')
  return content
    .map((part) => {
      if (!part) return ''
      if (part.type === 'text') return String(part.text ?? '')
      if (part.type === 'image') return imageMark
      return ''
    })
    .filter(Boolean)
    .join(' ')
    .trim()
}

/** 文本部分是否为空（决定这条消息要不要发出去） */
function hasContent(content) {
  if (isParts(content)) {
    return content.some((part) => {
      if (!part) return false
      if (part.type === 'text') return String(part.text ?? '').trim() !== ''
      if (part.type === 'image') return Boolean(part.url || part.data)
      return false
    })
  }
  return String(content ?? '').trim() !== ''
}

function toOpenAIContent(content, imageDetail) {
  if (!isParts(content)) return content
  return content
    .map((part) => {
      if (!part) return null
      if (part.type === 'text') {
        return { type: 'text', text: String(part.text ?? '') }
      }
      if (part.type === 'image') {
        const url = part.data
          ? `data:${part.mediaType || 'image/jpeg'};base64,${part.data}`
          : part.url
        if (!url) return null
        const imageUrl = { url }
        // 只有显式配置了才带 detail —— 有些兼容服务商不认这个字段
        if (imageDetail) imageUrl.detail = imageDetail
        return { type: 'image_url', image_url: imageUrl }
      }
      return null
    })
    .filter(Boolean)
}

function toAnthropicContent(content) {
  if (!isParts(content)) return content
  return content
    .map((part) => {
      if (!part) return null
      if (part.type === 'text') {
        return { type: 'text', text: String(part.text ?? '') }
      }
      if (part.type === 'image') {
        if (part.data) {
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: part.mediaType || 'image/jpeg',
              data: part.data
            }
          }
        }
        if (part.url) {
          return { type: 'image', source: { type: 'url', url: part.url } }
        }
      }
      return null
    })
    .filter(Boolean)
}

/**
 * Anthropic 要求 messages 里不能有 system 角色，
 * 且必须「以 user 开头 + 角色交替」，所以这里要把 system 抽出来，
 * 并把连续的相同角色合并（分段内容按数组拼接）。
 */
export function toAnthropicMessages(messages) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => partsToPlainText(m.content))
    .filter(Boolean)
    .join('\n\n')

  const merged = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (!hasContent(message.content)) continue

    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const last = merged[merged.length - 1]

    if (last && last.role === role) {
      if (isParts(last.content) || isParts(message.content)) {
        const left = isParts(last.content) ? last.content : [{ type: 'text', text: last.content }]
        const right = isParts(message.content) ? message.content : [{ type: 'text', text: message.content }]
        last.content = [...left, ...right]
      } else {
        last.content = `${last.content}\n${message.content}`
      }
    } else {
      merged.push({ role, content: message.content })
    }
  }

  // 首条必须是 user：丢掉开头多余的 assistant（例如从群聊记录里带进来的机器人发言）
  while (merged.length > 0 && merged[0].role !== 'user') merged.shift()
  if (merged.length === 0) merged.push({ role: 'user', content: '(空)' })

  return {
    system,
    messages: merged.map((message) => ({
      role: message.role,
      content: toAnthropicContent(message.content)
    }))
  }
}

/** 构造请求体，抽成独立函数便于单测 */
export function buildRequestBody(provider, { model, messages, temperature, maxTokens, imageDetail }) {
  if (provider === 'anthropic') {
    const { system, messages: dialog } = toAnthropicMessages(messages)
    const body = {
      model,
      max_tokens: maxTokens,
      temperature,
      messages: dialog
    }
    if (system) body.system = system
    return body
  }

  return {
    model,
    messages: messages.map((message) => ({
      role: message.role,
      content: toOpenAIContent(message.content, imageDetail)
    })),
    temperature,
    max_tokens: maxTokens,
    stream: false
  }
}

function buildHeaders(provider, apiKey, anthropicVersion) {
  if (provider === 'anthropic') {
    return {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': anthropicVersion
    }
  }
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`
  }
}

const ENDPOINT_SUFFIX = {
  anthropic: '/messages',
  openai: '/chat/completions'
}

const KNOWN_SUFFIXES = ['/chat/completions', '/completions', '/messages']

/**
 * 拼接请求地址。
 * 容错：很多人会把完整端点（.../v1/chat/completions）整个粘进「API 地址」，
 * 再拼一次就变成 .../chat/completions/chat/completions 直接 404。
 * 这里如果发现地址里已经带了端点，就原样使用，并在与所选协议不符时告警。
 */
export function buildUrl(provider, base) {
  const wanted = ENDPOINT_SUFFIX[provider]
  const matched = KNOWN_SUFFIXES.find((suffix) => base.endsWith(suffix))

  if (matched) {
    if (matched !== wanted) {
      logger.warn(
        `[${pluginName}] API 地址里已经带了 ${matched}，与当前协议（应为 ${wanted}）不符，` +
        '已按你填的地址原样使用，请检查「使用 Anthropic 协议」开关。'
      )
    }
    return base
  }

  return base + wanted
}

/**
 * 发起一次对话请求。
 * @returns {Promise<string|null>} 成功返回文本，失败返回 null
 */
async function chat(options = {}) {
  const apiKey = pickApiKey(Cfg.get('apiKey', ''))
  if (!apiKey) {
    logger.error(`[${pluginName}] 未配置 API Key，功能不可用。请在「插件配置 → DeepChat-plugin」中填写。`)
    return null
  }

  const { provider, base, fallback } = resolveEndpoint()
  const model = options.model || Cfg.get('model', '') || PROVIDER_DEFAULT_MODEL[provider]
  const temperature = Number(options.temperature ?? Cfg.get('temperature', 1))
  const maxTokens = Number(options.maxTokens ?? Cfg.get('maxTokens', 512))
  const timeoutMs = Cfg.getNumber('timeoutMs', 60000, 1000, 600000)
  const attemptMax = Cfg.getNumber('attemptMax', 2, 1, 10)
  const anthropicVersion = Cfg.get('anthropicVersion', '2023-06-01')

  if (fallback) {
    logger.warn(`[${pluginName}] 未填写 API 地址，按 ${provider} 协议回落到 ${base}`)
  }

  // 注意：content 可能是分段数组（含图片），所以不能用 typeof === 'string' 过滤
  const cleanMessages = (options.messages || []).filter(
    (m) => m && m.role && hasContent(m.content)
  )
  if (cleanMessages.length === 0) {
    logger.warn(`[${pluginName}] 没有有效消息可发送`)
    return null
  }

  const url = buildUrl(provider, base)
  const body = buildRequestBody(provider, {
    model,
    messages: cleanMessages,
    temperature,
    maxTokens,
    anthropicVersion,
    // detail 是 OpenAI 兼容协议里 image_url 的字段，Anthropic 的 image 块没有它
    imageDetail: provider === 'openai' ? normalizeImageDetail(Cfg.get('imageDetail', '')) : ''
  })
  const headers = buildHeaders(provider, apiKey, anthropicVersion)

  for (let attempt = 1; attempt <= attemptMax; attempt++) {
    try {
      const result = await postJson(url, headers, body, timeoutMs)

      if (!result.ok) {
        throw new Error(`${extractErrorMessage(result)}`)
      }

      const content = provider === 'anthropic'
        ? extractAnthropicText(result.data)
        : extractOpenAIText(result.data)

      if (!content) {
        throw new Error('API 返回内容为空')
      }
      return content
    } catch (error) {
      const reason = error?.name === 'AbortError'
        ? `请求超时（${timeoutMs}ms）`
        : (error?.message || error)
      logger.error(`[${pluginName}] API 调用失败（第 ${attempt}/${attemptMax} 次）：${reason}`)
      if (attempt >= attemptMax) return null
    }
  }

  return null
}

/** 供 #chat状态 使用：不暴露 key，只报告配置是否完整 */
function describe() {
  const { provider, base, fallback } = resolveEndpoint()
  const keys = String(Cfg.get('apiKey', '')).replace(/[，；;\n]/g, ',').split(',').map((k) => k.trim()).filter(Boolean)
  return {
    provider,
    base,
    fallback,
    keyCount: keys.length,
    model: Cfg.get('model', '') || PROVIDER_DEFAULT_MODEL[provider],
    transport: transportName()
  }
}

export default {
  chat,
  describe,
  resolveEndpoint,
  toAnthropicMessages,
  buildRequestBody,
  buildUrl,
  partsToPlainText,
  hasContent,
  normalizeImageDetail
}

export { PROVIDER_DEFAULTS, PROVIDER_DEFAULT_MODEL }
