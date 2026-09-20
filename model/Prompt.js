/**
 * 人设（提示词）预设：**一套人设一个 JSON 文件**。
 *
 * 为什么放文件、而不是塞进面板配置：
 *   锅巴保存时会把**整份配置**一次性 PUT 上来，而宿主 express 的请求体上限是
 *   100KB（body-parser 默认值）。角色卡那种长人设直接撞 413，面板里根本存不进去
 *   —— 报错还是「保存失败」，很难看出是体积问题。放文件就完全不受这条限制。
 *
 * 目录：data/prompts/<名字>.json（可用面板「人设目录」改）
 * {
 *   "title": "达达利亚",
 *   "content": "……",
 *   "updatedAt": 1789000000000
 * }
 *
 * 主人命令：
 *   #设置人设 达达利亚          + 引用一条消息（最长那种就靠这个）
 *   #设置人设 达达利亚 你是一只猫娘
 *   #切换提示词 达达利亚 / #切换提示词1 / #切换提示词0（回面板默认）
 *   #删除人设 达达利亚
 *   #提示词列表
 */
import fs from 'node:fs'
import path from 'node:path'
import Cfg from './Cfg.js'
import ChatState from './ChatState.js'
import { pluginData, pluginName } from '../config/constant.js'
import { parseIdList, idIn } from './utils.js'

const DEFAULT_DIR = path.join(pluginData, 'prompts')

/** 人设目录：面板留空就是插件目录下的 data/prompts */
export function promptDir() {
  const raw = String(Cfg.get('promptDir', '') || '').trim()
  if (!raw) return DEFAULT_DIR
  return path.isAbsolute(raw) ? raw : path.resolve(pluginData, raw)
}

/** 名字 → 文件名：去掉路径分隔符之类不能进文件名的字符 */
function safeKey(title, fallback) {
  const clean = String(title ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^\.+/, '')
  return (clean || `preset${fallback}`).slice(0, 40)
}

function readPreset(file) {
  const full = path.join(promptDir(), file)
  if (!fs.existsSync(full)) return null
  const key = file.replace(/\.json$/i, '')
  try {
    const parsed = JSON.parse(fs.readFileSync(full, 'utf8'))
    const title = String(parsed?.title ?? '').trim() || key
    return {
      index: 0,
      key,
      title,
      content: String(parsed?.content ?? ''),
      groups: parseIdList(parsed?.groups),
      users: parseIdList(parsed?.users),
      file: full,
      updatedAt: Number(parsed?.updatedAt) || 0
    }
  } catch (error) {
    logger.warn(`[${pluginName}] 读取人设文件 ${file} 失败：${error.message || error}`)
    return null
  }
}

function listFiles() {
  const dir = promptDir()
  let files = []
  try {
    if (fs.existsSync(dir)) {
      files = fs.readdirSync(dir).filter((file) => /\.json$/i.test(file)).sort()
    }
  } catch (error) {
    logger.warn(`[${pluginName}] 读取人设目录失败：${error.message || error}`)
    return []
  }
  return files.map(readPreset).filter(Boolean)
}

/**
 * 老版本把预设存在面板里（cfg.json 的 promptList）。
 * 目录**还不存在**时把它们搬成文件，之后面板那份就不用了。
 * 目录已经存在（哪怕是空的）就不再搬 —— 免得你删光文件后又被自动塞回来。
 */
let migrating = false

function migrateFromConfig() {
  // 防重入：下面的 savePreset 会读写同一个目录，别再绕回来
  if (migrating) return 0
  const rows = Cfg.get('promptList', [])
  if (!Array.isArray(rows) || rows.length === 0) return 0
  if (fs.existsSync(promptDir())) return 0

  migrating = true
  try {
    let saved = 0
    for (const row of rows) {
      const title = String(row?.title ?? '').trim()
      const content = String(row?.content ?? '').trim()
      if (!title && !content) continue
      if (savePreset(title || `人设${saved + 1}`, content)) saved++
    }
    if (saved > 0) {
      logger.mark(`[${pluginName}] 已把面板里的 ${saved} 套人设搬到 ${promptDir()}，之后以文件为准`)
    }
    return saved
  } finally {
    migrating = false
  }
}

/** 当前有哪些人设；序号就是这里面的顺序 */
export function presetList() {
  let items = listFiles()
  if (items.length === 0) {
    migrateFromConfig()
    items = listFiles()
  }
  return items.map((item, i) => ({ ...item, index: i + 1 }))
}

/** 按序号（1 起）、文件名或名字找人设，找不到返回 null */
export function findPreset(key) {
  const text = String(key ?? '').trim()
  if (!text) return null

  const list = presetList()
  if (/^\d+$/.test(text)) return list.find((preset) => preset.index === Number(text)) || null

  const lower = text.toLowerCase()
  return list.find((preset) => preset.key.toLowerCase() === lower) ||
    list.find((preset) => preset.title.toLowerCase() === lower) ||
    list.find((preset) => preset.title.toLowerCase().includes(lower)) ||
    null
}

/**
 * 写一套人设（同名覆盖）。
 * @param {string} title 显示名
 * @param {string} content 人设内容
 * @param {{groups?: any, users?: any}} [extra] 适用群 / 适用私聊；不传就保留文件里原有的
 */
export function savePreset(title, content, extra = {}) {
  const name = String(title ?? '').trim()
  if (!name) return null

  const dir = promptDir()
  const key = safeKey(name, Date.now())
  const file = path.join(dir, `${key}.json`)
  // 直接读同名文件，别走 presetList —— 那会触发自动搬迁，搬的时候又调回这里
  const existing = readPreset(`${key}.json`)

  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify({
      title: name,
      content: String(content ?? ''),
      groups: extra.groups !== undefined ? parseIdList(extra.groups) : parseIdList(existing?.groups),
      users: extra.users !== undefined ? parseIdList(extra.users) : parseIdList(existing?.users),
      updatedAt: Date.now()
    }, null, 2), 'utf8')
  } catch (error) {
    logger.error(`[${pluginName}] 保存人设「${name}」失败：${error.message || error}`)
    return null
  }

  return { key, title: name, file }
}

/** 删一套人设；返回被删的那套，没找到返回 null */
export function removePreset(key) {
  const preset = findPreset(key)
  if (!preset) return null
  try {
    fs.unlinkSync(preset.file)
    return preset
  } catch (error) {
    logger.error(`[${pluginName}] 删除人设「${preset.title}」失败：${error.message || error}`)
    return null
  }
}

/**
 * 当前会话真正生效的人设。优先级从高到低：
 *   1. 本会话手动切过（#切换提示词）—— 最优先，这是当场下的命令
 *   2. 面板为这个群 / 这个私聊安排的人设
 *   3. 面板里指定的「默认人设文件」
 *   4. 面板里的默认人设文本（prompt）
 *
 * @returns {{index: number, key: string, title: string, content: string, from: string}}
 */
export function activePrompt(e) {
  const list = presetList()
  const isGroup = Boolean(e?.isGroup)
  const sessionId = String((isGroup ? e?.group_id : e?.user_id) ?? '')

  // 1. 本会话手动切过
  const choice = ChatState.getPromptChoice(e)
  if (choice) {
    const hit = list.find((preset) => preset.key === choice) ||
      list.find((preset) => preset.title === choice) ||
      (/^\d+$/.test(choice) ? list.find((preset) => preset.index === Number(choice)) : null)
    if (hit) return { ...hit, from: '本会话手动切换' }
  }

  // 2. 面板按群 / 按私聊安排的人设
  //    群只认「适用群」，私聊只认「适用私聊」—— 不然群号碰巧等于某个 QQ 号就会串味
  if (sessionId) {
    const assigned = list.find((preset) => isGroup
      ? idIn(preset.groups, sessionId)
      : idIn(preset.users, sessionId))
    if (assigned) return { ...assigned, from: '面板安排' }
  }

  // 3. 面板指定的默认人设文件
  const fallbackKey = String(Cfg.get('promptDefault', '') || '').trim()
  if (fallbackKey) {
    const preset = findPreset(fallbackKey)
    if (preset) return { ...preset, from: '面板默认人设文件' }
  }

  // 4. 面板里的默认人设文本
  return {
    index: 0,
    key: '',
    title: '',
    content: String(Cfg.get('prompt', '') || '').trim(),
    from: '面板默认文本'
  }
}

/**
 * 面板那一栏要显示的行：**只给文件名和显示名，内容一律留空**。
 *
 * 关键就在这个「留空」：锅巴保存时会把整份配置一次性提交，宿主 express 的
 * 请求体上限是 100KB —— 要是把长人设的内容也回给面板，一点保存就又撞 413。
 * 留空之后面板那份请求始终很小，长文只存在文件里。
 */
export function panelRows() {
  return presetList().map((preset) => ({
    key: preset.key,
    title: preset.title,
    content: '',
    groups: preset.groups.join(','),
    users: preset.users.join(',')
  }))
}

/**
 * 把面板提交的这几行落成文件。
 *   - 改了显示名 → 文件跟着改名（旧文件删掉）
 *   - 填了内容   → 覆盖文件内容；留空 → 保持文件里原有的
 *   - 行被删掉   → 对应的人设文件一起删（面板删行 = 删人设）
 * @returns {{ok: boolean, saved: number, removed: number}}
 */
export function applyPanelRows(rows) {
  const list = presetList()
  const keep = new Set()
  let saved = 0

  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row?.key ?? '').trim()
    const title = String(row?.title ?? '').trim()
    const content = String(row?.content ?? '')
    if (!key && !title && !content.trim()) continue

    const existing = key ? list.find((preset) => preset.key === key) : null
    const finalTitle = title || existing?.title || key
    if (!finalTitle) continue

    const finalContent = content.trim() ? content : (existing?.content ?? '')
    if (!finalContent.trim() && !existing) continue

    // 适用群 / 适用私聊：面板给了就按面板的来（清空即取消分配）
    const result = savePreset(finalTitle, finalContent, {
      groups: row?.groups ?? existing?.groups ?? [],
      users: row?.users ?? existing?.users ?? []
    })
    if (!result) continue
    keep.add(result.key)
    saved++

    // 改名导致文件名变了：把旧文件删掉，别留下重复的人设
    if (existing && result.key !== existing.key) {
      keep.add(existing.key)        // 旧名字不再参与后面那轮删除，免得又去删一次
      try {
        fs.unlinkSync(existing.file)
      } catch (error) {
        logger.warn(`[${pluginName}] 重命名后删除旧人设文件失败：${error.message || error}`)
      }
    }
  }

  let removed = 0
  for (const preset of list) {
    if (keep.has(preset.key)) continue
    try {
      fs.unlinkSync(preset.file)
      removed++
    } catch (error) {
      logger.warn(`[${pluginName}] 删除人设文件失败：${error.message || error}`)
    }
  }

  return { ok: true, saved, removed }
}

/** 给命令看的一段说明 */
export function describeList(e) {
  const list = presetList()
  const active = activePrompt(e)
  const lines = [`【人设列表】目录：${promptDir()}`]

  if (list.length === 0) {
    lines.push('还没有人设文件。新增：#设置人设 名字 内容，或引用一条消息发 #设置人设 名字。')
  } else {
    for (const preset of list) {
      const mark = active.key && active.key === preset.key ? ' ←当前' : ''
      const size = preset.content.length > 0
        ? `（${preset.content.length} 字 / ${(Buffer.byteLength(preset.content, 'utf8') / 1024).toFixed(1)}KB）`
        : '（空）'
      const where = []
      if (preset.groups.length > 0) where.push(`群 ${preset.groups.join('、')}`)
      if (preset.users.length > 0) where.push(`私聊 ${preset.users.join('、')}`)
      lines.push(`${preset.index}. ${preset.title}${size}${where.length > 0 ? `　→ ${where.join('，')}` : ''}${mark}`)
    }
    lines.push('', `当前生效：${active.key ? active.title : '面板里的默认人设'}（来自${active.from}）`)
  }

  lines.push('切换： #切换提示词1　/　#切换提示词 名字　/　#切换提示词0（回到面板安排）')
  lines.push('新增 / 覆盖： #设置人设 名字 内容（也可引用一条消息）')
  lines.push('删除： #删除人设 名字')
  return lines.join('\n')
}

export default {
  promptDir,
  presetList,
  findPreset,
  savePreset,
  removePreset,
  activePrompt,
  describeList,
  panelRows,
  applyPanelRows
}
