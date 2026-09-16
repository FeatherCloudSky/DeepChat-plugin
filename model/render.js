import { pluginName } from '../config/constant.js'

/**
 * 调用 Yunzai 的渲染器把模板截图成图片，成功返回 base64，失败返回 null。
 *
 * 为什么用 retType: 'base64' 而不是默认值：
 * 看 Miao-Yunzai lib/plugins/runtime.js 的 render() 实现（TRSS-Yunzai 行为一致，已实机验证），末尾是
 *   let ret = true
 *   if (base64) { ret = await this.e.reply(base64) }
 *   return cfg.retType === 'msgId' ? ret : true
 * 也就是说默认模式下**即使截图失败、base64 为空，它也照样返回 true**，
 * 调用方无从分辨「发出去了」和「静默失败」。那样我们的纯文本兜底永远不会触发。
 * 用 base64 模式把图拿回来自己发，才能判断真假。
 */
export default async function render(tplPath, params, cfg = {}) {
  const e = cfg.e
  if (!e?.runtime?.render) {
    logger.error(`[${pluginName}] 未找到 e.runtime.render，无法出图（请升级 Yunzai）`)
    return null
  }

  try {
    const image = await e.runtime.render(pluginName, tplPath, params, {
      retType: 'base64',
      beforeRender({ data }) {
        return {
          ...data,
          sys: { scale: cfg.scale || 1 }
        }
      }
    })
    return image || null
  } catch (error) {
    logger.error(`[${pluginName}] 渲染 ${tplPath} 失败：${error.message || error}`)
    return null
  }
}
