/**
 * 并发与频率限制。
 *
 * 单会话排队（SessionQueue）解决的是「同一个群的消息别乱序」，
 * 但它挡不住「100 个私聊同时打 API」—— 那是另一种耗尽：额度被打空、
 * 连接数打满、进程内存被响应体顶爆。
 *
 * 这里补两个维度：
 *   - 全局并发闸门：同一时刻最多放行 N 个重活（API 请求、图片下载）；
 *   - 按会话的频率窗口：一分钟内同一个群/同一个人最多发起几次。
 *
 * 两者都只做「拒绝并说明」，不静默丢消息。
 */
import Cfg from './Cfg.js'

/** 等闸门等太久就直接失败，别让消息挂在队列里无休止地等 */
export class ConcurrencyLimitError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConcurrencyLimitError'
    this.code = 'ECONCURRENCY'
  }
}

/** 超过了本会话每分钟的请求次数 */
export class RateLimitError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RateLimitError'
    this.code = 'ERATELIMIT'
  }
}

const states = new Map()

function stateOf(name) {
  let state = states.get(name)
  if (!state) {
    state = { active: 0, waiters: [] }
    states.set(name, state)
  }
  return state
}

/**
 * 在名为 name 的闸门里跑 fn，最多同时 limit 个。
 * 排队超时抛 ConcurrencyLimitError。
 */
export async function withSlot(name, limit, fn, maxWaitMs = 20000) {
  const effective = Math.max(1, Math.floor(Number(limit) || 1))
  const state = stateOf(name)

  if (state.active >= effective) {
    await new Promise((resolve, reject) => {
      const waiter = { resolve, timer: null }
      waiter.timer = setTimeout(() => {
        const at = state.waiters.indexOf(waiter)
        if (at >= 0) state.waiters.splice(at, 1)
        reject(new ConcurrencyLimitError('当前并发请求过多，请稍后再试。'))
      }, maxWaitMs)
      waiter.timer.unref?.()
      state.waiters.push(waiter)
    })
  }

  state.active++
  try {
    return await fn()
  } finally {
    state.active--
    const next = state.waiters.shift()
    if (next) {
      clearTimeout(next.timer)
      next.resolve()
    }
  }
}

/** 全局 API 并发上限（面板可调） */
export function apiConcurrency() {
  return Math.floor(Cfg.getNumber('apiMaxConcurrent', 6, 1, 64))
}

/** 全局下载并发上限（面板可调） */
export function downloadConcurrency() {
  return Math.floor(Cfg.getNumber('downloadMaxConcurrent', 4, 1, 64))
}

const windows = new Map()

/**
 * 滑动窗口频率检查。perMinute <= 0 表示不限制。
 * @returns {boolean} 这次是否放行
 */
export function allowPerMinute(key, perMinute = 0, now = Date.now()) {
  const limit = Math.floor(Number(perMinute) || 0)
  if (limit <= 0) return true

  const id = String(key ?? '')
  if (!id) return true

  const rows = (windows.get(id) || []).filter((t) => now - t < 60000)
  if (rows.length >= limit) {
    windows.set(id, rows)
    return false
  }
  rows.push(now)
  windows.set(id, rows)

  // 顺手收掉已经空掉的窗口，避免长期运行后 Map 越来越大
  if (windows.size > 4096) {
    for (const [name, list] of windows) {
      if (list.length === 0 || now - list[list.length - 1] > 120000) windows.delete(name)
    }
  }
  return true
}

/** 只读快照，便于状态命令与测试 */
export function snapshot() {
  return {
    api: { active: stateOf('api').active, waiting: stateOf('api').waiters.length },
    download: { active: stateOf('download').active, waiting: stateOf('download').waiters.length }
  }
}

export default { withSlot, apiConcurrency, downloadConcurrency, allowPerMinute, snapshot, ConcurrencyLimitError, RateLimitError }
