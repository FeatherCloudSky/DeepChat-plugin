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
 * 这次发送到底成没成。
 *
 * 关键：宿主**不抛异常**，而是把失败塞进返回值里 ——
 *   TRSS 的 loader.reply() 里 try/catch 包着发送，出错时返回 { error: [...] }，
 *   协议端（NapCat）失败时返回 { status: 'failed', retcode: 1200, ... }。
 * 只判断「有没有抛错」会把失败当成功，然后静静地什么都不发。
 */
function isSendFailed(res) {
  if (!res || typeof res !== 'object') return false
  if (res.error) return true
  if (res.status === 'failed') return true
  if (typeof res.retcode === 'number' && res.retcode !== 0) return true
  return false
}

/** 从返回值里抠一句能看的错误说明 */
function describeFailure(res) {
  const raw = res?.error || res
  return String(raw?.message || raw?.wording || '').split('\n')[0].slice(0, 120) || '发送失败'
}

/**
 * 把一张图发出去，一种写法失败了就换下一种。
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function replyImage(e, buffer) {
  let lastError = ''
  for (const candidate of imageCandidates(buffer)) {
    try {
      const res = await e.reply(candidate)
      if (!isSendFailed(res)) return { ok: true }
      lastError = describeFailure(res)
      logger.warn(`[${pluginName}] 这种发图方式被拒绝（${lastError}），换下一种`)
    } catch (error) {
      lastError = error?.message || String(error)
      logger.warn(`[${pluginName}] 这种发图方式报错（${lastError}），换下一种`)
    }
  }
  return { ok: false, error: lastError }
}
