import Broadcast, { normalizeGroupIds, parseGapRange } from '../model/Broadcast.js'
import Permission from '../model/Permission.js'
import Cfg from '../model/Cfg.js'
import { pluginName } from '../config/constant.js'

const fmtTime = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false })

/** 读一遍面板里配好的群发参数 */
function readPlan() {
  return {
    groups: normalizeGroupIds(Cfg.get('broadcastGroups', [])),
    content: String(Cfg.get('broadcastContent', '') ?? '').trim(),
    delayMinutes: Cfg.getNumber('broadcastDelayMinutes', 1, 0, 1440),
    maxGroups: Cfg.getNumber('broadcastMaxGroups', 20, 1, 100),
    gap: String(Cfg.get('broadcastGapSeconds', '10-60') ?? '10-60')
  }
}

export class broadcast extends plugin {
  constructor() {
    super({
      name: `[${pluginName}]群发`,
      dsc: '定时群发',
      event: 'message',
      priority: -3000,
      rule: [
        { reg: '^#群发$', fnc: 'send' },
        { reg: '^#群发状态$', fnc: 'status' },
        { reg: '^#群发取消$', fnc: 'cancel' }
      ]
    })
  }

  deny(e) {
    return e.reply(`只有主人才能群发（你当前是${Permission.roleLabel(e)}）。`)
  }

  async send(e) {
    if (!Permission.isMaster(e)) return this.deny(e)

    const plan = readPlan()

    if (plan.groups.length === 0) {
      return e.reply('还没选群。去「插件配置 → DeepChat-plugin → 群发消息」里勾选要发的群，再发一次 #群发。')
    }
    if (!plan.content) {
      return e.reply('还没填内容。去面板「群发消息」标签页填写「群发内容」，再发一次 #群发。')
    }
    if (plan.groups.length > plan.maxGroups) {
      return e.reply(
        `选中的群有 ${plan.groups.length} 个，超过上限 ${plan.maxGroups} 个。\n` +
        '要么在面板里调大「单次群发群数上限」，要么减少群数——一次发太多很容易被平台风控。'
      )
    }

    const { minMs, maxMs } = parseGapRange(plan.gap)
    const job = Broadcast.schedule({
      groups: plan.groups,
      content: plan.content,
      delayMinutes: plan.delayMinutes,
      gap: plan.gap,
      by: e.user_id
    })

    if (!job) {
      return e.reply('已经有一条群发在等着了，发 #群发状态 看进度，或者 #群发取消 撤掉它。')
    }

    const preview = plan.content.length > 60 ? plan.content.slice(0, 60) + '……' : plan.content
    const waitText = plan.delayMinutes > 0 ? `${plan.delayMinutes} 分钟后` : '立即'
    return e.reply([
      '【群发已排定】',
      `群数：${plan.groups.length} 个`,
      `发送时间：${fmtTime(job.fireAt)}（${waitText}）`,
      `群与群之间随机等：${minMs / 1000} ~ ${maxMs / 1000} 秒`,
      `内容预览：${preview}`,
      '',
      '中途想撤销就发 #群发取消。'
    ].join('\n'))
  }

  async status(e) {
    if (!Permission.isMaster(e)) return this.deny(e)
    const s = Broadcast.status()
    if (!s) return e.reply('当前没有等待中的群发任务。')

    const minutes = Math.max(0, Math.round(s.remainingMs / 60000))
    const preview = s.content.length > 40 ? s.content.slice(0, 40) + '……' : s.content
    return e.reply([
      '【群发进行中】',
      `群数：${s.groups.length} 个`,
      `预计发送：${fmtTime(s.fireAt)}（约 ${minutes} 分钟后）`,
      `内容预览：${preview}`,
      '',
      '发 #群发取消 可以撤销。'
    ].join('\n'))
  }

  async cancel(e) {
    if (!Permission.isMaster(e)) return this.deny(e)
    const job = Broadcast.cancel()
    if (!job) return e.reply('当前没有等待中的群发任务。')
    return e.reply(`已取消群发（原定发往 ${job.groups.length} 个群）。`)
  }
}
