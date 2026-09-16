import { pluginName } from '../config/constant.js'

/**
 * 调用 Yunzai 的渲染器把模板截图成图片。
 * 返回消息 id / 结果，若宿主不支持渲染则返回 false，由调用方决定怎么兜底。
 */
export default function render(tplPath, params, cfg = {}) {
  const e = cfg.e
  if (!e?.runtime) {
    logger.error(`[${pluginName}] 未找到 e.runtime，请升级 Yunzai 后再使用图片帮助`)
    return false
  }

  try {
    return e.runtime.render(pluginName, tplPath, params, {
      retType: cfg.retMsgId ? 'msgId' : 'default',
      beforeRender({ data }) {
        return {
          ...data,
          sys: { scale: cfg.scale || 1 }
        }
      }
    })
  } catch (error) {
    logger.error(`[${pluginName}] 渲染 ${tplPath} 失败：${error.message || error}`)
    return false
  }
}
