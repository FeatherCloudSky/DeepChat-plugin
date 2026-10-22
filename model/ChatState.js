/**
 * 每个群 / 每个私聊的「是否启用 AI」独立开关。
 *
 * 存在 data/state.json，与 cfg.json 分开：
 *  - 会话级开关会随聊天命令（#chat开 / #chat关）频繁变动，不适合塞进配置面板；
 *  - 独立文件也便于备份或整体清空。
 *
 * 结构：
 * {
 *   "groups": { "1234567890:123456": true },
 *   "users":  { "1234567890:10001": false },
 *   "groupPrompts": { "1234567890:123456": "群用人设" },
 *   "userPrompts":  { "1234567890:10001": "私聊人设" }
 * }
 * 键里的前缀是机器人自己的 QQ（self_id）：多机器人共用一个 Redis / 进程时，
 * 同一个群在 A 机器人上关掉、在 B 机器人上开着，是两个独立的事实，不能混。
 * 老版本存的是不带前缀的纯群号/QQ 号，读取时会回退去查那一种，写新值时不再生成。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pluginData, pluginName } from '../config/constant.js'
import { writeJsonAtomic } from './storage.js'

const STATE_FILE = path.join(pluginData, 'state.json')

let state = { groups: {}, users: {}, groupPrompts: {}, userPrompts: {} }

const buckets = (parsed) => ({
  groups: parsed?.groups && typeof parsed.groups === 'object' ? parsed.groups : {},
  users: parsed?.users && typeof parsed.users === 'object' ? parsed.users : {},
  groupPrompts: parsed?.groupPrompts && typeof parsed.groupPrompts === 'object' ? parsed.groupPrompts : {},
  userPrompts: parsed?.userPrompts && typeof parsed.userPrompts === 'object' ? parsed.userPrompts : {}
})

function load() {
  try {
    if (!fs.existsSync(STATE_FILE)) return
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return
    state = buckets(parsed)
  } catch (error) {
    logger.warn(`[${pluginName}] 读取 state.json 失败：${error.message || error}`)
  }
}

/**
 * 直接同步落盘。
 *
 * 早先用的是 300ms 防抖 —— 结果是 `#chat关` 之后如果机器人立刻重启，
 * 这次开关就丢了。这类命令是用户手动触发的低频操作，
 * 同步写一次的开销完全可以接受，不该拿数据可靠性换这点性能。
 */
function saveNow() {
  try {
    writeJsonAtomic(STATE_FILE, state)
    return true
  } catch (error) {
    logger.error(`[${pluginName}] 保存 state.json 失败：${error.message || error}`)
    return false
  }
}

function updateState(change) {
  const previous = JSON.parse(JSON.stringify(state))
  change()
  if (saveNow()) return true
  state = previous
  return false
}

function bucket(e) {
  return e.isGroup ? state.groups : state.users
}

function promptBucket(e) {
  return e.isGroup ? state.groupPrompts : state.userPrompts
}

/** 机器人身份：多机器人共用一个进程/Redis 时必须区分开 */
function botOf(e) {
  const id = String(e?.self_id ?? e?.selfId ?? '').trim()
  return id || 'default'
}

/** 新格式：<self_id>:<群号或QQ号> */
function sessionKey(e) {
  return `${botOf(e)}:${String(e.isGroup ? e.group_id : e.user_id)}`
}

/** 旧格式：只有群号/QQ号，只在读书时兜底 */
function legacyKey(e) {
  return String(e.isGroup ? e.group_id : e.user_id)
}

function readScoped(bucketMap, e) {
  const scoped = bucketMap[sessionKey(e)]
  if (scoped !== undefined) return scoped
  return bucketMap[legacyKey(e)]
}

load()

const ChatState = {
  /** 返回 true / false / null（null 表示没有单独设置过） */
  getOverride(e) {
    const value = readScoped(bucket(e), e)
    return typeof value === 'boolean' ? value : null
  },

  setOverride(e, enabled) {
    return updateState(() => {
      bucket(e)[sessionKey(e)] = Boolean(enabled)
      delete bucket(e)[legacyKey(e)]
    }) ? Boolean(enabled) : null
  },

  /** 清除单个会话的设置，回到默认策略 */
  clearOverride(e) {
    return updateState(() => {
      delete bucket(e)[sessionKey(e)]
      delete bucket(e)[legacyKey(e)]
    })
  },

  /** 清空所有会话设置 */
  clearAll() {
    return updateState(() => { state = { groups: {}, users: {}, groupPrompts: {}, userPrompts: {} } })
  },

  /**
   * 本会话选中的是哪套人设（存的是文件名/名字，不是序号 ——
   * 序号会随着文件增减而变，存序号会让你选了的人设悄悄跑掉）。
   * 没设过返回 null。
   */
  getPromptChoice(e) {
    const value = readScoped(promptBucket(e), e)
    return value === undefined || value === null || value === '' ? null : String(value)
  },

  setPromptChoice(e, choice) {
    return updateState(() => {
      promptBucket(e)[sessionKey(e)] = String(choice)
      delete promptBucket(e)[legacyKey(e)]
    }) ? String(choice) : null
  },

  /** 清除本会话的人设选择，回到面板默认 */
  clearPromptChoice(e) {
    return updateState(() => {
      delete promptBucket(e)[sessionKey(e)]
      delete promptBucket(e)[legacyKey(e)]
    })
  },

  /** 统计数量，供 #chat状态 展示 */
  count() {
    const countBool = (obj, value) => Object.values(obj).filter((v) => v === value).length
    return {
      groupOn: countBool(state.groups, true),
      groupOff: countBool(state.groups, false),
      userOn: countBool(state.users, true),
      userOff: countBool(state.users, false)
    }
  },

  snapshot() {
    return JSON.parse(JSON.stringify(state))
  },

  file: STATE_FILE
}

export default ChatState
