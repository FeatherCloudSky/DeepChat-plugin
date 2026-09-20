/**
 * 每个群 / 每个私聊的「是否启用 AI」独立开关。
 *
 * 存在 data/state.json，与 cfg.json 分开：
 *  - 会话级开关会随聊天命令（#chat开 / #chat关）频繁变动，不适合塞进配置面板；
 *  - 独立文件也便于备份或整体清空。
 *
 * 结构：
 * {
 *   "groups": { "123456": true, "234567": false },
 *   "users":  { "10001": false },
 *   "groupPrompts": { "123456": 2 },
 *   "userPrompts":  { "10001": 1 }
 * }
 * 未出现在这里的会话，走配置里的默认值 + 启用/禁用列表。
 * 后两个桶存的是「这个会话用人设预设里的第几套」（#切换提示词），
 * 没出现过就用面板里的默认人设。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pluginData, pluginName } from '../config/constant.js'

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
    fs.mkdirSync(pluginData, { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, '\t'), 'utf8')
  } catch (error) {
    logger.error(`[${pluginName}] 保存 state.json 失败：${error.message || error}`)
  }
}

function bucket(e) {
  return e.isGroup ? state.groups : state.users
}

function promptBucket(e) {
  return e.isGroup ? state.groupPrompts : state.userPrompts
}

function sessionKey(e) {
  return String(e.isGroup ? e.group_id : e.user_id)
}

load()

const ChatState = {
  /** 返回 true / false / null（null 表示没有单独设置过） */
  getOverride(e) {
    const value = bucket(e)[sessionKey(e)]
    return typeof value === 'boolean' ? value : null
  },

  setOverride(e, enabled) {
    bucket(e)[sessionKey(e)] = Boolean(enabled)
    saveNow()
    return Boolean(enabled)
  },

  /** 清除单个会话的设置，回到默认策略 */
  clearOverride(e) {
    delete bucket(e)[sessionKey(e)]
    saveNow()
  },

  /** 清空所有会话设置 */
  clearAll() {
    state = { groups: {}, users: {}, groupPrompts: {}, userPrompts: {} }
    saveNow()
  },

  /**
   * 本会话选中的是哪套人设（存的是文件名/名字，不是序号 ——
   * 序号会随着文件增减而变，存序号会让你选了的人设悄悄跑掉）。
   * 没设过返回 null。
   */
  getPromptChoice(e) {
    const value = promptBucket(e)[sessionKey(e)]
    return value === undefined || value === null || value === '' ? null : String(value)
  },

  setPromptChoice(e, choice) {
    promptBucket(e)[sessionKey(e)] = String(choice)
    saveNow()
    return String(choice)
  },

  /** 清除本会话的人设选择，回到面板默认 */
  clearPromptChoice(e) {
    delete promptBucket(e)[sessionKey(e)]
    saveNow()
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
