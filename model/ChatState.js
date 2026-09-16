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
 *   "users":  { "10001": false }
 * }
 * 未出现在这里的会话，走配置里的默认值 + 启用/禁用列表。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pluginData, pluginName } from '../config/constant.js'

const STATE_FILE = path.join(pluginData, 'state.json')

let state = { groups: {}, users: {} }

function load() {
  try {
    if (!fs.existsSync(STATE_FILE)) return
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return
    state = {
      groups: parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : {},
      users: parsed.users && typeof parsed.users === 'object' ? parsed.users : {}
    }
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
    state = { groups: {}, users: {} }
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
