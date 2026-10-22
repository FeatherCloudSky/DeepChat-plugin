/**
 * 内容嗅探：不看扩展名，只看字节。
 *
 * 为什么单独放一个模块：聊天图片、汤面图片、人设文本文件都要判断
 * 「这堆字节到底是什么」，而 image.js 还带着缩放与渲染器依赖，
 * 让只做判断的地方去 import 它会把渲染器一起拖进来。
 */

/** 已知图片格式的文件头。返回扩展名，认不出返回空字符串。 */
export function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return ''

  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
      buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return '.png'
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg'
  const head6 = buffer.subarray(0, 6).toString('latin1')
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return '.gif'
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
      buffer.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp'
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return '.bmp'
  // AVIF / HEIC：ISO-BMFF，第二个 box 是 ftyp，品牌在白名单里
  if (buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('latin1').toLowerCase()
    if (['avif', 'avis', 'heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand)) return '.avif'
  }
  return ''
}

/** 这段字节是不是「有意义的文本」：不含 NUL、替换字符占比低 */
export function looksLikeText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false
  if (buffer.includes(0)) return false

  const sample = buffer.subarray(0, Math.min(buffer.length, 64 * 1024))
  const text = sample.toString('utf8')
  const replacement = (text.match(/\uFFFD/g) || []).length
  return replacement / Math.max(1, text.length) < 0.05
}
