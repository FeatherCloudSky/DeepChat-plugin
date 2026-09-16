/**
 * 权限判定：主人 / 管理员 / 普通成员。
 *
 * 主人：
 *   1. 配置里填的 masterQQ（只认一个，多填只取第一个）
 *   2. 以及 Yunzai 自身的 e.isMaster —— 宿主定义的机器人主人始终保留主人权限，
 *      插件不应该把他削弱掉。
 * 管理员：
 *   主人，或者 adminQQ 列表里的人。列表最多生效 MAX_ADMINS 个，超出部分忽略并告警。
 */
import Cfg from './Cfg.js'
import { pluginName } from '../config/constant.js'
import { parseIdList } from './utils.js'

export const MAX_ADMINS = 5

export const ROLE = {
  MASTER: 'master',
  ADMIN: 'admin',
  MEMBER: 'member'
}

const ROLE_LABEL = {
  master: '主人',
  admin: '管理员',
  member: '普通成员'
}

let warnedOverflow = false

/** 配置里的主人 QQ，没填返回空字符串 */
export function masterId() {
  return parseIdList(Cfg.get('masterQQ', ''))[0] || ''
}

/** 配置里的管理员 QQ，已按上限截断 */
export function adminIds() {
  const list = parseIdList(Cfg.get('adminQQ', []))
  if (list.length > MAX_ADMINS) {
    if (!warnedOverflow) {
      warnedOverflow = true
      logger.warn(
        `[${pluginName}] 管理员最多 ${MAX_ADMINS} 个，配置里有 ${list.length} 个，` +
        `多余的会被忽略：${list.slice(MAX_ADMINS).join(', ')}`
      )
    }
    return list.slice(0, MAX_ADMINS)
  }
  return list
}

function userIdOf(e) {
  return String(e?.user_id ?? e?.userId ?? '')
}

export function isMaster(e) {
  if (!e) return false
  const id = userIdOf(e)
  if (!id) return Boolean(e.isMaster)
  const master = masterId()
  if (master && id === master) return true
  return Boolean(e.isMaster)
}

export function isAdmin(e) {
  if (!e) return false
  if (isMaster(e)) return true
  const id = userIdOf(e)
  return Boolean(id) && adminIds().includes(id)
}

export function roleOf(e) {
  if (isMaster(e)) return ROLE.MASTER
  if (isAdmin(e)) return ROLE.ADMIN
  return ROLE.MEMBER
}

export function roleLabel(e) {
  return ROLE_LABEL[roleOf(e)] || ROLE_LABEL.member
}

/** 当前权限配置的摘要，供 #chat状态 展示 */
export function summary() {
  const master = masterId()
  const admins = adminIds()
  return {
    master: master || '（未设置，使用 Yunzai 自身的 isMaster）',
    admins,
    adminsRaw: parseIdList(Cfg.get('adminQQ', [])).length,
    maxAdmins: MAX_ADMINS
  }
}

export default { isMaster, isAdmin, roleOf, roleLabel, masterId, adminIds, summary, MAX_ADMINS, ROLE }
