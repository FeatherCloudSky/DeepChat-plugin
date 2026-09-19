/**
 * 发图片的统一入口。
 *
 * 为什么不能直接 e.reply(Buffer)：
 *   TRSS-Yunzai 的 OneBot v11 适配器（plugins/adapter/OneBotv11.js）里，
 *   makeMsg() 只处理「消息段」—— 段落里的 Buffer 才会被转成 base64://
 *   交给协议端。裸 Buffer 在它眼里只是个普通 object，会被展开成一个
 *   没有 type 的对象，协议端收到直接忽略：不报错、也不发图，
 *   表现就是「文本到了，图没了」。
 *
 *   icqq 系适配器直接发 Buffer 是正常的（Yunzai 自己的渲染器就这么干），
 *   所以这个坑只在 OneBot 系（NapCat / Lagrange 等）上出现。
 *
 * 依次尝试三种写法，前两种都是「图片段」，最后一种兜底 icqq 老写法。
 */
import { pluginName } from '../config/constant.js'

/** 一张图的可选发送形态，按可靠性从高到低 */
export function imageCandidates(buffer) {
  const list = []
  const seg = globalThis.segment
  if (seg && typeof seg.image === 'function') {
    try {
      list.push(seg.image(buffer))
    } catch (error) {
      // 拿不到就算了，后面还有等价写法
    }
  }
  list.push({ type: 'image', data: { file: buffer } })
  list.push(buffer)
  return list
}

/**
 * 把一张图发出去。
 * @returns {Promise<boolean>} 是否发出去了（某种形态没抛错）
 */
export async function replyImage(e, buffer) {
  for (const candidate of imageCandidates(buffer)) {
    try {
      await e.reply(candidate)
      return true
    } catch (error) {
      logger.warn(`[${pluginName}] 这种发图方式失败，换下一种：${error.message || error}`)
    }
  }
  return false
}
