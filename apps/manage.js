import ChatState from '../model/ChatState.js'
import Policy from '../model/Policy.js'
import Provider from '../model/Provider.js'
import Permission from '../model/Permission.js'
import Cfg from '../model/Cfg.js'
import { pluginName } from '../config/constant.js'

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
        { reg: '^#chat全开$', fnc: 'resetAll' }
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
