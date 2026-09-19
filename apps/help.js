import path from 'node:path'
import { pathToFileURL } from 'node:url'
import Cfg from '../model/Cfg.js'
import HelpContent from '../model/HelpContent.js'
import render from '../model/render.js'
import { replyImage } from '../model/message.js'
import { pluginName, pluginResources } from '../config/constant.js'
import { isBlank } from '../model/utils.js'

/** 插件自带的默认背景 */
const DEFAULT_BG = path.join(pluginResources, 'help', 'theme', 'default', 'bg.jpg')

/**
 * 解析帮助背景：
 *   留空           -> 插件自带的默认图
 *   http/data/file -> 直接用
 *   其它           -> 当作本地路径；相对路径按 Yunzai 根目录解析，转成 file:// URL
 * 不依赖渲染器注入的 _res_path，自己算绝对路径，这样换机器、换目录都不会失效。
 */
function resolveBackground() {
  const raw = String(Cfg.get('helpBg', '') ?? '').trim()
  if (isBlank(raw)) return pathToFileURL(DEFAULT_BG).href
  if (/^(https?:|data:|file:)/i.test(raw)) return raw

  const absolute = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw)
  return pathToFileURL(absolute).href
}

export class help extends plugin {
  constructor() {
    super({
      name: `[${pluginName}]帮助`,
      dsc: 'DeepChat 帮助',
      event: 'message',
      // 负数优先级 = 在 loader 的升序队列里更早被检查，
      // 这样 #DeepHelp 不会被 chat.js 的前缀规则抢走。
      priority: -10000,
      rule: [
        // 主命令：#DeepHelp（大小写不敏感，# 可省略）
        { reg: '^#?[Dd][Ee][Ee][Pp][Hh][Ee][Ll][Pp]$', fnc: 'help' },
        // 兼容别名
        { reg: '^#?[Dd]eep[Cc]hat(插件)?(帮助|命令|菜单|说明|指令|功能|[Hh]elp)$', fnc: 'help' },
        { reg: '^#?[Dd]eep(插件)?(帮助|命令|菜单|说明|指令|功能|[Hh]elp)$', fnc: 'help' }
      ]
    })
  }

  buildRenderData(content) {
    return {
      pluginName,
      helpTitle: String(Cfg.get('helpTitle', '') ?? '').trim() || content.title || `${pluginName} 帮助`,
      helpSubTitle: String(Cfg.get('helpSubTitle', '') ?? '').trim() || pluginName,
      groups: content.groups,
      bg: resolveBackground(),
      mask: (Cfg.getNumber('helpBgMask', 45, 0, 95) / 100).toFixed(2),
      blur: Cfg.getNumber('helpBgBlur', 6, 0, 30),
      accent: String(Cfg.get('helpAccent', '#ffd9a0') ?? '#ffd9a0'),
      width: Cfg.getNumber('helpWidth', 1200, 600, 2400)
    }
  }

  async help(e = this.e) {
    const content = HelpContent.loadHelp()

    // 优先出图。render() 成功时返回图片字节，失败返回 null，
    // 所以「截图失败」这种情况能真的兜住，而不是静默什么都不回。
    // 发图统一走 replyImage（消息段），裸 Buffer 在 OneBot 系适配器上会被丢掉。
    const image = await render('help/index', this.buildRenderData(content), { e, scale: 1.15 })
    if (image) {
      const sent = typeof e?.reply === 'function' ? await replyImage(e, image) : false
      if (sent) return true
      logger.warn(`[${pluginName}] 帮助图发不出去，改发纯文本`)
    }

    const text = HelpContent.toPlainText(content)
    if (typeof e?.reply === 'function') return e.reply(text)
    return this.reply(text)
  }
}
