/**
 * 决策层：判断「这个会话能不能用 AI」以及「这条消息该不该被伪人模式接话」。
 * 把判断逻辑从 apps/chat.js 里抽出来，便于单独测试。
 */
import Cfg from './Cfg.js'
import ChatState from './ChatState.js'
import { pluginName } from '../config/constant.js'
import { idIn } from './utils.js'

/**
 * AI 名称匹配。
 *
 * 默认是「关键词包含」：消息里**任意位置**出现这个名字就算命中，不需要 @。
 * 例如名字叫「达达利亚」，那么「不知道达达利亚圣遗物带什么好」会触发。
 *
 * 开启正则模式后按正则匹配；正则写错时自动退回关键词匹配，
 * 不会因为一个配置项把整条回复链路搞崩。
 */
export function matchAiName(text, aiName, useRegex = false) {
  const name = String(aiName ?? '').trim()
  if (!name) return false

  const source = String(text ?? '')
  if (!source) return false

  if (!useRegex) return source.includes(name)

  try {
    return new RegExp(name).test(source)
  } catch (error) {
    logger.warn(`[${pluginName}] aiName 不是合法正则，已按关键词处理：${error.message || error}`)
    return source.includes(name)
  }
}

/** AI 触发关键词的数量上限 */
export const MAX_KEYWORDS = 20

let warnedKeywordOverflow = false

/** 读取关键词列表：支持数组，也支持用逗号 / 分号 / 换行分隔的字符串 */
export function keywordList() {
  const raw = Cfg.get('aiKeywords', [])
  const items = Array.isArray(raw)
    ? raw.map((item) => String(item ?? '').trim())
    : String(raw ?? '').split(/[,，;；\n]+/).map((item) => item.trim())

  const list = [...new Set(items.filter(Boolean))]

  if (list.length > MAX_KEYWORDS) {
    if (!warnedKeywordOverflow) {
      warnedKeywordOverflow = true
      logger.warn(
        `[${pluginName}] 触发关键词最多 ${MAX_KEYWORDS} 个，配置里有 ${list.length} 个，` +
        `多余的会被忽略：${list.slice(MAX_KEYWORDS).join('、')}`
      )
    }
    return list.slice(0, MAX_KEYWORDS)
  }
  return list
}

/**
 * 关键词匹配：纯字面包含，不做正则解释。
 * 返回命中的那个关键词，没命中返回空字符串。
 */
export function matchAiKeyword(text, keywords = keywordList()) {
  const source = String(text ?? '')
  if (!source || keywords.length === 0) return ''
  for (const keyword of keywords) {
    if (keyword && source.includes(keyword)) return keyword
  }
  return ''
}

/**
 * 会话级启用判定。优先级从高到低：
 *   1. 私聊总开关 enablePrivate（只对私聊生效，关掉就一律不响应）
 *   2. 会话级单独设置（#chat开 / #chat关 写进 state.json）
 *   3. 禁用列表 disabledGroups / disabledUsers
 *   4. 启用列表 enabledGroups / enabledUsers
 *   5. 全局默认值 enableByDefault
 */
function resolveEnabled(e) {
  if (!e) return false

  if (!e.isGroup && !Cfg.getBool('enablePrivate', true)) return false

  const override = ChatState.getOverride(e)
  if (override !== null) return override

  const id = e.isGroup ? e.group_id : e.user_id
  const disabled = Cfg.getIdList(e.isGroup ? 'disabledGroups' : 'disabledUsers')
  const enabled = Cfg.getIdList(e.isGroup ? 'enabledGroups' : 'enabledUsers')

  if (idIn(disabled, id)) return false
  if (idIn(enabled, id)) return true

  return Cfg.getBool('enableByDefault', true)
}

/**
 * 伪人模式（被动插话）的触发资格。
 * 只管「被动触发」，不影响 #chat 主动命令和 @。
 */
function shouldPseudoTrigger(e) {
  const userId = e.user_id
  const groupId = e.group_id

  const whitelistUsers = Cfg.getIdList('pseudoWhitelistUsers')
  const blacklistUsers = Cfg.getIdList('pseudoBlacklistUsers')
  const whitelistGroups = Cfg.getIdList('pseudoWhitelistGroups')
  const blacklistGroups = Cfg.getIdList('pseudoBlacklistGroups')

  if (whitelistUsers.length > 0 && !idIn(whitelistUsers, userId)) return false
  if (blacklistUsers.length > 0 && idIn(blacklistUsers, userId)) return false

  if (e.isGroup) {
    if (whitelistGroups.length > 0 && !idIn(whitelistGroups, groupId)) return false
    if (blacklistGroups.length > 0 && idIn(blacklistGroups, groupId)) return false
  }

  return true
}

/** 生成一句人类可读的启用状态描述，供 #chat状态 使用 */
function describe(e) {
  const override = ChatState.getOverride(e)
  const enabled = resolveEnabled(e)
  const source = override !== null
    ? '会话单独设置'
    : (idIn(Cfg.getIdList(e.isGroup ? 'disabledGroups' : 'disabledUsers'), e.isGroup ? e.group_id : e.user_id)
        ? '禁用列表'
        : (idIn(Cfg.getIdList(e.isGroup ? 'enabledGroups' : 'enabledUsers'), e.isGroup ? e.group_id : e.user_id)
            ? '启用列表'
            : '全局默认值'))
  return { enabled, source, override }
}

export { resolveEnabled, shouldPseudoTrigger, describe }

export default {
  resolveEnabled,
  shouldPseudoTrigger,
  describe,
  matchAiName,
  matchAiKeyword,
  keywordList,
  MAX_KEYWORDS
}
