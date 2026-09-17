/**
 * 一次性定时群发。
 *
 * Guoba 的配置面板只能读写配置值、没有「按一下按钮就执行」的机制，
 * 所以分工是：**面板负责所有参数，一条命令扣扳机**（#群发）。
 * 好处是天然多了一道闸 —— 群发是这类插件里最容易把号发没的动作，
 * 不该「改个配置就自动发出去」。
 *
 * 任务会持久化到 data/broadcast.json：排定之后机器人重启，只要还没到点也会接着发。
 */
import fs from 'node:fs'
import path from 'node:path'
import Cfg from './Cfg.js'
import { pluginData, pluginName } from '../config/constant.js'

const FILE = path.join(pluginData, 'broadcast.json')

/** 迟到超过这么久就丢弃（重启后发现任务早就过期了，再发出去会很突兀） */
const OVERDUE_DROP_MINUTES = 60

let pending = null
let timer = null

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 把面板里存的群列表归一成纯数字 id 数组。
 * GSelectGroup 存成什么形状不好保证（可能是 [123]、['123']、[{id,name}]），所以都兜一下。
 */
export function normalizeGroupIds(value) {
  if (value === undefined || value === null || value === '') return []

  let list = value
  if (!Array.isArray(list)) {
    if (typeof list === 'string') {
      list = list.split(/[,，;；\s]+/)
    } else {
      list = [list]
    }
  }

  const out = []
  for (const item of list) {
    let id = item
    if (item && typeof item === 'object') {
      id = item.id ?? item.group_id ?? item.groupId ?? item.value ?? item.gid
    }
    const num = Number(id)
    if (Number.isFinite(num) && num > 0 && !out.includes(num)) out.push(num)
  }
  return out
}

/** 解析 "10-60" 这样的秒区间；不合法就用兜底值 */
export function parseGapRange(raw, defMin = 10, defMax = 60) {
  const fallback = { minMs: defMin * 1000, maxMs: defMax * 1000 }
  const text = String(raw ?? '').trim()
  if (!text) return fallback

  // 注意：Number('') 是 0 而不是 NaN，所以空格必须单独判空，
  // 否则「留空」会被当成「0 秒」，变成 0~60 这种诡异的区间。
  const nums = text.split('-').map((part) => {
    const t = part.trim()
    if (!t) return null
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  })

  let min = nums[0]
  let max = nums.length > 1 ? nums[1] : null
  if (min === null && max === null) return fallback
  if (min === null) min = max            // "10-" 这种写一半的
  if (max === null) max = min            // "30" 表示固定 30 秒

  if (min < 0) min = 0
  if (max < min) [min, max] = [max, min]
  if (max > 600) max = 600
  if (min > max) min = max               // 夹完上限后 min 可能反超

  return { minMs: min * 1000, maxMs: max * 1000 }
}

function readJob() {
  try {
    if (!fs.existsSync(FILE)) return null
    const job = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return job && Array.isArray(job.groups) && job.groups.length > 0 ? job : null
  } catch (error) {
    logger.warn(`[${pluginName}] 读取群发任务失败：${error.message || error}`)
    return null
  }
}

function writeJob(job) {
  try {
    fs.mkdirSync(pluginData, { recursive: true })
    if (job) fs.writeFileSync(FILE, JSON.stringify(job, null, '\t'), 'utf8')
    else if (fs.existsSync(FILE)) fs.unlinkSync(FILE)
  } catch (error) {
    logger.error(`[${pluginName}] 保存群发任务失败：${error.message || error}`)
  }
}

function pickGroup(gid) {
  const bot = globalThis.Bot
  if (!bot) throw new Error('Bot 全局量不可用')
  if (typeof bot.pickGroup === 'function') return bot.pickGroup(gid)
  const self = bot[bot.uin]
  if (self && typeof self.pickGroup === 'function') return self.pickGroup(gid)
  throw new Error('Bot.pickGroup 不可用（当前协议可能不支持主动发群消息）')
}

function notifyUser(uid, text) {
  try {
    const bot = globalThis.Bot
    if (!bot || !uid) return
    const user = typeof bot.pickUser === 'function' ? bot.pickUser(uid) : bot[bot.uin]?.pickUser?.(uid)
    user?.sendMsg?.(text)
  } catch (error) {
    logger.debug(`[${pluginName}] 群发结果私聊失败：${error.message || error}`)
  }
}

/** 真正开跑 */
async function run(job) {
  pending = null
  writeJob(null)

  const { minMs, maxMs } = parseGapRange(job.gap)
  const ok = []
  const failed = []

  for (let i = 0; i < job.groups.length; i++) {
    // 第一条不等，之后每条之间随机等一会儿 —— 这才是「像人」而不是「机器扫射」
    if (i > 0) await sleep(minMs + Math.random() * (maxMs - minMs))

    const gid = job.groups[i]
    try {
      await pickGroup(gid).sendMsg(job.content)
      ok.push(gid)
      logger.mark(`[${pluginName}] 群发成功：${gid}`)
    } catch (error) {
      failed.push(gid)
      logger.error(`[${pluginName}] 群发失败：${gid} -> ${error.message || error}`)
    }
  }

  const summary = [
    '【群发完成】',
    `成功 ${ok.length} 个${ok.length ? '：' + ok.join('、') : ''}`,
    `失败 ${failed.length} 个${failed.length ? '：' + failed.join('、') : ''}`
  ].join('\n')
  logger.mark(`[${pluginName}] ${summary.replace(/\n/g, ' ')}`)
  notifyUser(job.by, summary)
}

function arm(job) {
  pending = job
  const delay = job.fireAt - Date.now()
  timer = setTimeout(() => {
    run(job).catch((error) => {
      logger.error(`[${pluginName}] 群发执行异常：${error.message || error}`)
    })
  }, Math.max(0, delay))
}

/** 启动时恢复未到点的任务；已经过期的按规则丢弃 */
function restore() {
  const job = readJob()
  if (!job) return

  const overdueMinutes = (Date.now() - job.fireAt) / 60000

  if (overdueMinutes > OVERDUE_DROP_MINUTES) {
    writeJob(null)
    logger.warn(`[${pluginName}] 丢弃一条 ${Math.round(overdueMinutes)} 分钟前就该发的群发任务（已过期太久）`)
    return
  }

  arm(job)
  const waitMinutes = Math.max(0, Math.round((job.fireAt - Date.now()) / 60000))
  logger.mark(`[${pluginName}] 恢复了一条群发任务：${job.groups.length} 个群，约 ${waitMinutes} 分钟后发送`)
}

restore()

const Broadcast = {
  /** 排定任务，返回任务对象；已有任务在等则返回 null */
  schedule({ groups, content, delayMinutes, gap, by }) {
    if (pending) return null
    const job = {
      groups,
      content,
      gap: String(gap ?? ''),
      by: String(by ?? ''),
      fireAt: Date.now() + Math.max(0, Number(delayMinutes) || 0) * 60000,
      createdAt: Date.now()
    }
    writeJob(job)
    arm(job)
    return job
  },

  cancel() {
    if (!pending) return null
    const job = pending
    pending = null
    if (timer) clearTimeout(timer)
    timer = null
    writeJob(null)
    return job
  },

  status() {
    if (!pending) return null
    return {
      ...pending,
      remainingMs: Math.max(0, pending.fireAt - Date.now())
    }
  },

  file: FILE
}

export default Broadcast
