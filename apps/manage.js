import fs from 'node:fs'
import path from 'node:path'
import ChatState from '../model/ChatState.js'
import Policy from '../model/Policy.js'
import Provider from '../model/Provider.js'
import Permission from '../model/Permission.js'
import Prompt from '../model/Prompt.js'
import { segmentsToText } from '../model/Recorder.js'
import { getBuffer } from '../model/http.js'
import Cfg from '../model/Cfg.js'
import { pluginName } from '../config/constant.js'
import { findQuotedMessage, isFetchableUrl } from '../model/utils.js'

/** 当文本读的文件后缀，以及单个人设文件的体积上限 */
const TEXT_FILE_RE = /\.(txt|md|markdown|json|ya?ml|csv|log|ini|conf)$/i
const TEXT_FILE_MAX = 1024 * 1024

/** 从文件段里读出文本：本机临时文件优先，其次下载地址 */
async function readTextSegment(segment) {
  const data = segment?.data && typeof segment.data === 'object' ? segment.data : segment
  const fileField = String(data?.file ?? '')
  const urlField = String(data?.url ?? '')

  const candidates = []
  if (fileField && !/^https?:\/\//i.test(fileField)) {
    candidates.push(fileField, path.resolve(process.cwd(), fileField), path.resolve(process.cwd(), 'data', fileField))
  }
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue
      const stat = fs.statSync(candidate)
      if (!stat.isFile() || stat.size === 0 || stat.size > TEXT_FILE_MAX) continue
      return fs.readFileSync(candidate, 'utf8')
    } catch (error) {
      // 换下一个候选路径继续试
    }
  }

  const url = /^https?:\/\//i.test(urlField) ? urlField : (/^https?:\/\//i.test(fileField) ? fileField : '')
  if (!url || !isFetchableUrl(url)) return ''

  try {
    const result = await getBuffer(url, 15000, TEXT_FILE_MAX)
    if (!result.ok || !result.buffer?.length) return ''
    return result.buffer.toString('utf8')
  } catch (error) {
    logger.warn(`[${pluginName}] 下载人设文件失败：${error.message || error}`)
    return ''
  }
}

/**
 * 被引用那条消息里的内容。两种来源：
 *   1. 消息里带了 txt 之类的文本文件 → 读文件内容（长人设推荐这条路，怎么写都不嫌长）
 *   2. 否则取消息里的文字
 * @returns {Promise<{text: string, from: string}>}
 */
async function quotedContent(quoted) {
  if (!quoted) return { text: '', from: '' }

  const segments = Array.isArray(quoted.message) ? quoted.message : null
  if (!segments) return { text: String(quoted.raw_message || '').trim(), from: '消息文字' }

  const fileSegment = segments.find((segment) => {
    if (segment?.type !== 'file') return false
    const data = segment?.data && typeof segment.data === 'object' ? segment.data : segment
    return TEXT_FILE_RE.test(String(data?.name || data?.file || ''))
  })

  if (fileSegment) {
    const text = (await readTextSegment(fileSegment)).replace(/^\uFEFF/, '').trim()
    if (text) return { text, from: '被引用的文本文件' }
  }

  return { text: segmentsToText(segments).trim(), from: '消息文字' }
}

export class manage extends plugin {
  constructor() {
    super({
      name: `[${pluginName}]管理`,
      dsc: 'DeepChat 会话开关',
      event: 'message',
      // 必须比 chat.js 更早被检查，否则 ^#chat 会把 #chat开 当成聊天内容
      priority: -5000,
      rule: [
        { reg: '^#chat开$', fnc: 'enable' },
        { reg: '^#chat关$', fnc: 'disable' },
        { reg: '^#chat重置$', fnc: 'reset' },
        { reg: '^#chat状态$', fnc: 'status' },
        { reg: '^#chat全开$', fnc: 'resetAll' },
        // 人设切换：只有主人能动（见 switchPrompt 里的判定）
        { reg: '^[#＃]\\s*切换提示词\\s*\\S*\\s*$', fnc: 'switchPrompt' },
        { reg: '^[#＃]\\s*提示词列表$', fnc: 'promptList' },
        { reg: '^[#＃]\\s*设置人设\\s*\\S+', fnc: 'savePrompt' },
        { reg: '^[#＃]\\s*删除人设\\s*\\S+', fnc: 'removePrompt' }
      ]
    })
  }

  sessionName(e) {
    return e.isGroup ? `本群（${e.group_id}）` : `本私聊（${e.user_id}）`
  }

  /** 能不能开关当前会话：主人 / 管理员，或配置里放开了普通成员 */
  canToggle(e) {
    if (Permission.isAdmin(e)) return true
    return Cfg.getBool('allowMemberToggle', false)
  }

  denyToggle(e) {
    return e.reply(`只有主人和管理员才能开关 AI 对话（你当前是${Permission.roleLabel(e)}）。`)
  }

  async enable(e) {
    if (!this.canToggle(e)) return this.denyToggle(e)
    if (!e.isGroup && !Cfg.getBool('enablePrivate', true)) {
      return e.reply('私聊功能已被总开关关闭，请先在插件配置里开启「私聊中使用」。')
    }
    ChatState.setOverride(e, true)
    return e.reply(`已启用 ${this.sessionName(e)} 的 AI 对话。`)
  }

  async disable(e) {
    if (!this.canToggle(e)) return this.denyToggle(e)
    ChatState.setOverride(e, false)
    return e.reply(`已停用 ${this.sessionName(e)} 的 AI 对话。发送 #chat开 可以重新启用。`)
  }

  async reset(e) {
    if (!this.canToggle(e)) return this.denyToggle(e)
    ChatState.clearOverride(e)
    const { enabled, source } = Policy.describe(e)
    return e.reply(`已清除本会话的单独设置，当前状态：${enabled ? '启用' : '停用'}（来自${source}）。`)
  }

  async resetAll(e) {
    if (!Permission.isMaster(e)) return e.reply('只有主人才能执行这个操作。')
    ChatState.clearAll()
    return e.reply('已清空所有会话级开关，全部回到配置里的默认策略。')
  }

  /**
   * 切换本会话的人设预设。只有主人能发（这条命令会改机器人的说话方式，
   * 不该让管理员或群友随手改）。
   */
  async switchPrompt(e) {
    if (!Permission.isMaster(e)) return e.reply('只有主人才能切换人设。')

    const arg = String(e.msg || '').replace(/^[#＃]\s*切换提示词/, '').trim()
    if (!arg) return e.reply(Prompt.describeList(e))

    if (arg === '0' || arg === '默认' || arg === '默认人设') {
      ChatState.clearPromptChoice(e)
      const { from } = Prompt.activePrompt(e)
      return e.reply(`已把${this.sessionName(e)}的人设切回面板默认（来自${from}）。`)
    }

    const preset = Prompt.findPreset(arg)
    if (!preset) return e.reply(`没找到人设「${arg}」。\n\n${Prompt.describeList(e)}`)

    ChatState.setPromptChoice(e, preset.key)
    return e.reply(
      `已把${this.sessionName(e)}切换到人设 ${preset.index}. ${preset.title}。\n` +
      '这个会话之后的回复都用这套人设；发 #切换提示词0 可以回到面板默认。'
    )
  }

  /**
   * 新增 / 覆盖一套人设。两种写法：
   *   #设置人设 达达利亚 你是一只猫娘……
   *   #设置人设 达达利亚   ← 加上「引用一条消息」，内容取被引用那条
   * 第二种是给角色卡那种长文本准备的：直接贴容易发不全，引用最省事。
   */
  async savePrompt(e) {
    if (!Permission.isMaster(e)) return e.reply('只有主人才能设置人设。')

    const arg = String(e.msg || '').replace(/^[#＃]\s*设置人设\s*/, '').trim()
    if (!arg) return e.reply('用法：#设置人设 名字 内容，或者引用一条消息再发 #设置人设 名字。')

    const gap = arg.search(/\s/)
    const title = (gap === -1 ? arg : arg.slice(0, gap)).trim()
    let content = gap === -1 ? '' : arg.slice(gap).trim()

    let source = '命令后面的文字'
    if (!content) {
      const quoted = await findQuotedMessage(e)
      const picked = await quotedContent(quoted)
      content = picked.text
      source = picked.from || source
    }

    if (!content) {
      return e.reply(
        `没拿到「${title}」的内容。两种写法：\n` +
        `1. #设置人设 ${title} 你的内容是……\n` +
        `2. 引用一条写着人设的消息（或者带 txt 文档的消息），发 #设置人设 ${title}`
      )
    }

    const saved = Prompt.savePreset(title, content)
    if (!saved) return e.reply(`保存「${title}」失败，检查一下人设目录的写权限。`)

    return e.reply(
      `已保存人设「${saved.title}」（${content.length} 字，来自${source}）。\n` +
      `切换到它：#切换提示词 ${saved.title}\n` +
      `文件：${saved.file}`
    )
  }

  async removePrompt(e) {
    if (!Permission.isMaster(e)) return e.reply('只有主人才能删除人设。')

    const name = String(e.msg || '').replace(/^[#＃]\s*删除人设\s*/, '').trim()
    const removed = Prompt.removePreset(name)
    if (!removed) return e.reply(`没找到人设「${name}」。\n\n${Prompt.describeList(e)}`)

    return e.reply(`已删除人设「${removed.title}」，对应的人设文件也删掉了。`)
  }

  async promptList(e) {
    if (!Permission.isMaster(e)) return e.reply('只有主人才能查看人设列表。')
    return e.reply(Prompt.describeList(e))
  }

  async status(e) {
    const { enabled, source, override } = Policy.describe(e)
    const info = Provider.describe()
    const perm = Permission.summary()
    const count = ChatState.count()
    const lines = [
      `【${pluginName} 状态】`,
      `你的身份：${Permission.roleLabel(e)}`,
      `本会话：${enabled ? '已启用' : '已停用'}`,
      `判定来源：${source}${override === null ? '' : '（会话单独设置）'}`,
      `协议：${info.provider}　地址：${info.base}${info.fallback ? '（未填写，回落默认）' : ''}`,
      `模型：${info.model}`,
      `Key 数量：${info.keyCount}`,
      `传输层：${info.transport}${info.transport === 'fetch' ? '' : '（Node 16 兜底）'}`,
      `主人：${perm.master}`,
      `管理员：${perm.admins.length > 0 ? perm.admins.join('、') : '（未设置）'}` +
        (perm.adminsRaw > perm.maxAdmins ? `（配置了 ${perm.adminsRaw} 个，只生效前 ${perm.maxAdmins} 个）` : ''),
      `会话开关记录：群 ${count.groupOn} 开 / ${count.groupOff} 关，私聊 ${count.userOn} 开 / ${count.userOff} 关`
    ]
    return e.reply(lines.join('\n'))
  }
}
