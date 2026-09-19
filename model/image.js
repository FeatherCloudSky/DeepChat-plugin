/**
 * 图片尺寸识别 + 超限缩放。
 *
 * 为什么需要：汤面图要存到本地放一整天，得有个上限，免得有人发一张
 * 巨图把磁盘和内存顶爆。超限时不要直接丢掉，尽量缩到能存为止。
 *
 * 尺寸识别是纯 JS 读文件头，不依赖任何库：
 *   PNG  → IHDR 块
 *   JPEG → SOFn 段
 *   GIF  → 逻辑屏幕描述符
 *   WebP → VP8 / VP8L / VP8X
 *   BMP  → DIB 头
 *
 * 缩放借宿主自带的渲染器（puppeteer 那一套，出帮助图用的就是它）完成，
 * 插件自身依旧零第三方依赖；渲染器用不了就退回「跳过并说明」，不静默丢图。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { pluginData, pluginName } from '../config/constant.js'
import render from './render.js'

const IMAGE_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp'
}

/** 把 MIME / 扩展名统一成我们能处理的几个后缀 */
export function normalizeExt(ext) {
  const value = String(ext || '').toLowerCase()
  if (IMAGE_EXT[value]) return IMAGE_EXT[value]
  const bare = value.startsWith('.') ? value : `.${value}`
  if (bare === '.jpeg' || bare === '.jpg') return '.jpg'
  return ['.png', '.gif', '.webp', '.bmp'].includes(bare) ? bare : ''
}

/** 读文件头拿宽高；认不出来返回 null */
export function readImageSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null

  // PNG: 89 50 4E 47 ... IHDR
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    if (buffer.length < 24) return null
    return { type: '.png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }

  // GIF87a / GIF89a
  const head6 = buffer.subarray(0, 6).toString('latin1')
  if (head6 === 'GIF87a' || head6 === 'GIF89a') {
    return { type: '.gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  }

  // BMP
  if (buffer[0] === 0x42 && buffer[1] === 0x4d && buffer.length >= 26) {
    return {
      type: '.bmp',
      width: Math.abs(buffer.readInt32LE(18)),
      height: Math.abs(buffer.readInt32LE(22))
    }
  }

  // WebP: RIFF....WEBP
  if (buffer.length >= 30 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
      buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    const fourCC = buffer.subarray(12, 16).toString('latin1')
    if (fourCC === 'VP8X') {
      return {
        type: '.webp',
        width: (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1,
        height: (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1
      }
    }
    if (fourCC === 'VP8 ') {
      return {
        type: '.webp',
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff
      }
    }
    if (fourCC === 'VP8L') {
      const bits = buffer.readUInt32LE(21)
      return {
        type: '.webp',
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1
      }
    }
    return { type: '.webp', width: 0, height: 0 }
  }

  // JPEG: 扫到 SOFn 段
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 4 <= buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue }
      const marker = buffer[offset + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2
        continue
      }
      const length = buffer.readUInt16BE(offset + 2)
      const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
                    (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)
      if (isSof && offset + 9 <= buffer.length) {
        return {
          type: '.jpg',
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7)
        }
      }
      if (length < 2) break
      offset += 2 + length
    }
    return { type: '.jpg', width: 0, height: 0 }
  }

  return null
}

/** 这张图是不是超了上限（尺寸或体积） */
export function isOverLimit(size, bytes, { maxSide, maxBytes }) {
  if (bytes > maxBytes) return true
  if (!size || !size.width || !size.height) return false
  return Math.max(size.width, size.height) > maxSide
}

/**
 * 借渲染器把图缩到上限以内。
 *
 * 做法：把原图落成一个临时文件，让一个极简 HTML 把 <img> 按目标宽度显示出来，
 * 再截图 —— 得到的就是缩放后的图。宽了就先按单边上限缩，再按体积逐步往回收，
 * 直到装得下或者试完为止（最多 4 轮）。
 *
 * @returns {Promise<{data: Buffer, ext: string, width: number} | null>}
 */
export async function shrinkImage(e, buffer, size, limits) {
  if (!e?.runtime?.render) {
    logger.warn(`[${pluginName}] 没有渲染器，超限的汤面图没法自动缩小`)
    return null
  }
  if (!size?.width || !size?.height) return null

  const dir = path.join(pluginData, 'tmp')
  const name = `shrink-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${normalizeExt(size.type) || '.img'}`
  const file = path.join(dir, name)

  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, buffer)
  } catch (error) {
    logger.warn(`[${pluginName}] 写临时图失败，无法缩小：${error.message || error}`)
    return null
  }

  try {
    const src = pathToFileURL(file).href
    // 透明背景的图（PNG）继续用 PNG，其余用 JPEG —— JPEG 体积小得多
    const png = normalizeExt(size.type) === '.png' || normalizeExt(size.type) === '.gif'
    const params = () => (png ? { imgType: 'png' } : { imgType: 'jpeg', quality: 85 })

    let width = Math.min(size.width, limits.maxSide)
    for (let attempt = 0; attempt < 4; attempt++) {
      const out = await render('soup/shrink', { src, width, ...params() }, { e, scale: 1 })
      if (!out || !out.length) return null
      if (out.length <= limits.maxBytes) {
        logger.mark(
          `[${pluginName}] 汤面图超限，已自动缩小：${size.width}×${size.height}` +
          ` → 宽 ${width}（${(out.length / 1024 / 1024).toFixed(2)}MB）`
        )
        return { data: out, ext: png ? '.png' : '.jpg', width }
      }
      width = Math.round(width * 0.75)
      if (width < 320) break
    }
    logger.warn(`[${pluginName}] 汤面图缩到最小仍然超过体积上限`)
    return null
  } finally {
    try { fs.unlinkSync(file) } catch (error) { /* 临时文件删不掉不影响使用 */ }
  }
}
