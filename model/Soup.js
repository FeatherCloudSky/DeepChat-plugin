/**
 * 海龟汤的「汤面」暂存。
 *
 * 和聊天记录（Recorder）不一样：汤面是**一份**，不是一个列表。
 * 每个会话（群 / 私聊）同时只有一条汤面，重新记录就覆盖旧的。
 *
 * 汤面属于**会话**，不属于发汤面的人：A 发的汤面，B / C / D 谁引用它都能记，
 * 所以这里不记录「谁有资格」，只记「是谁记的」，权限判断放在 apps/soup.js。
 *
 * 存法：
 *   data/soup/<group_123456>.json   元信息（文字、图片文件名、过期时间）
 *   data/soup/<group_123456>_1.jpg  图片原始字节
 *
 * 为什么图片必须落盘、而不是只存一个 URL：QQ 的图片地址是临时的、带防盗链，
 * 过一阵就拉不到了。汤面要放一整天，只留 URL 大概率半路就变成死图。
 */
import fs from 'node:fs'
import path from 'node:path'
import Cfg from './Cfg.js'
import { pluginData, pluginName } from '../config/constant.js'

const DIR = path.join(pluginData, 'soup')

/** key -> meta */
const active = new Map()

/** 过期清扫的间隔：文件不会自己消失，得有人定时收 */
const SWEEP_INTERVAL_MS = 30 * 60 * 1000

const ensureDir = () => fs.mkdirSync(DIR, { recursive: true })

const sessionKey = (e) => (e?.isGroup ? `group_${e.group_id}` : `private_${e.user_id}`)

const sessionLabel = (e) => {
  if (!e?.isGroup) return '私聊'
  return e.group_name ? `群「${e.group_name}」` : `群 ${e.group_id}`
}

const metaFile = (key) => path.join(DIR, `${key}.json`)
const imageFile = (name) => path.join(DIR, name)

/** 保存时长（小时）——每次现读配置，面板改了立刻生效 */
const expireHours = () => Cfg.getNumber('soupExpireHours', 24, 1, 24 * 30)

const isExpired = (meta) => !meta?.expiresAt || meta.expiresAt <= Date.now()

function readMeta(key) {
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile(key), 'utf8'))
    if (!meta || typeof meta !== 'object' || !meta.key) return null
    if (!Array.isArray(meta.images)) meta.images = []
    return meta
  } catch (error) {
    return null
  }
}

function writeMeta(meta) {
  ensureDir()
  fs.writeFileSync(metaFile(meta.key), JSON.stringify(meta, null, 2), 'utf8')
}

/** 删掉这条汤面带的图片文件 */
function dropImages(meta) {
  for (const image of meta?.images || []) {
    if (!image?.name) continue
    try { fs.unlinkSync(imageFile(image.name)) } catch (error) { /* 文件可能已经不在了 */ }
  }
}

/** 抹掉一条汤面：内存 + 元信息 + 图片 */
function purge(key) {
  const meta = active.get(key) || readMeta(key)
  dropImages(meta)
  active.delete(key)
  try { fs.unlinkSync(metaFile(key)) } catch (error) { /* 同上 */ }
}

/**
 * 启动时恢复没到期的汤面、清掉过期的。
 *
 * 注意这里**不创建目录** —— 光 import 这个模块不该在磁盘上留东西，
 * 目录只在真正记录汤面时才建（见 save）。
 */
function restoreAndClean() {
  try {
    if (!fs.existsSync(DIR)) return
    let restored = 0
    let removed = 0

    for (const file of fs.readdirSync(DIR)) {
      if (!file.endsWith('.json')) continue
      const key = file.replace(/\.json$/, '')
      const meta = readMeta(key)
      if (!meta || isExpired(meta)) { purge(key); removed++; continue }
      active.set(key, meta)
      restored++
    }

    // 顺带收掉没有元信息对应的孤儿图片（比如上次删到一半断电了）
    for (const file of fs.readdirSync(DIR)) {
      if (file.endsWith('.json')) continue
      const key = file.replace(/_\d+\.[A-Za-z0-9]+$/, '')
      if (active.has(key)) continue
      try { fs.unlinkSync(imageFile(file)); removed++ } catch (error) { /* 忽略 */ }
    }

    if (restored > 0) logger.mark(`[${pluginName}] 恢复了 ${restored} 条汤面`)
    if (removed > 0) logger.info(`[${pluginName}] 清理了 ${removed} 条过期的汤面`)
  } catch (error) {
    logger.warn(`[${pluginName}] 恢复汤面失败：${error.message || error}`)
  }
}

restoreAndClean()

/** 定时清扫：没人访问也要把过期文件收掉，不然磁盘上会一直攒着 */
const sweeper = setInterval(() => {
  try {
    if (!fs.existsSync(DIR)) return
    for (const file of fs.readdirSync(DIR)) {
      if (!file.endsWith('.json')) continue
      const key = file.replace(/\.json$/, '')
      if (isExpired(active.get(key) || readMeta(key))) purge(key)
    }
  } catch (error) {
    logger.debug(`[${pluginName}] 清扫汤面失败：${error.message || error}`)
  }
}, SWEEP_INTERVAL_MS)
sweeper.unref?.()

const Soup = {
  dir: DIR,

  /** 会话 key，供外部展示用 */
  keyOf: sessionKey,

  /** 当前会话记着的汤面；没有或已过期返回 null */
  get(e) {
    const key = sessionKey(e)
    const meta = active.get(key) || readMeta(key)
    if (!meta) { active.delete(key); return null }
    if (isExpired(meta)) { purge(key); return null }
    active.set(key, meta)
    return meta
  },

  has(e) {
    return Boolean(this.get(e))
  },

  /**
   * 记下一条汤面（同会话已有的会被覆盖）。
   * @param {{ text?: string, images?: {data: Buffer, ext?: string, url?: string, mediaType?: string}[] }} content
   */
  save(e, content = {}) {
    const key = sessionKey(e)
    const now = Date.now()

    // 覆盖前先把旧的那条连图一起抹掉，免得占着磁盘还留着悬念
    purge(key)
    ensureDir()

    const meta = {
      key,
      isGroup: !!e?.isGroup,
      sessionId: String(e?.isGroup ? e.group_id : e?.user_id ?? ''),
      label: sessionLabel(e),
      createdAt: now,
      expiresAt: now + expireHours() * 3600 * 1000,
      ownerId: String(e?.user_id ?? ''),
      ownerName: String(e?.sender?.card || e?.sender?.nickname || e?.user_id || ''),
      text: String(content.text || '').trim(),
      images: []
    }

    const list = Array.isArray(content.images) ? content.images : []
    list.forEach((image, i) => {
      if (!image?.data?.length) return
      const name = `${key}_${i + 1}${image.ext || '.jpg'}`
      try {
        fs.writeFileSync(imageFile(name), image.data)
        meta.images.push({
          name,
          url: String(image.url || ''),
          mediaType: String(image.mediaType || 'image/jpeg'),
          bytes: image.data.length
        })
      } catch (error) {
        logger.warn(`[${pluginName}] 保存汤面图片失败：${error.message || error}`)
      }
    })

    writeMeta(meta)
    active.set(key, meta)
    return meta
  },

  /** 删除整条汤面；没有则返回 null */
  remove(e) {
    const key = sessionKey(e)
    const meta = active.get(key) || readMeta(key)
    if (!meta) { active.delete(key); return null }
    purge(key)
    return meta
  },

  /** 取出某张图的字节；文件不在了返回 null */
  imageBuffer(meta, image) {
    if (!image?.name) return null
    try {
      const buffer = fs.readFileSync(imageFile(image.name))
      return buffer.length > 0 ? buffer : null
    } catch (error) {
      return null
    }
  },

  /**
   * 「查看时重新计时」用的：开启后每次查看都把过期时间往后推。
   * @returns {boolean} 是否顺延了
   */
  touch(meta) {
    if (!meta || !Cfg.getBool('soupRefreshOnView', false)) return false
    meta.expiresAt = Date.now() + expireHours() * 3600 * 1000
    meta.viewedAt = Date.now()
    try { writeMeta(meta) } catch (error) { /* 写不进去也不影响这次查看 */ }
    return true
  },

  /** 当前所有汤面（供调试 / 状态展示） */
  list() {
    return [...active.values()].map((m) => ({ ...m }))
  }
}

export default Soup
