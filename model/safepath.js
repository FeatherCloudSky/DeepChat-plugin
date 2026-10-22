/**
 * 「读本机文件」的唯一入口。
 *
 * 适配器会在消息里给一个 file 字段 —— 可能是它自己落的临时文件，
 * 也可能是一个绝对路径。这个字段来自群消息，属于不可信输入：
 * 直接 fs.readFile 就等于把「读服务器上任意文件」的能力交给了发消息的人。
 *
 * 这里的规则：
 *   1. 只认受信任根目录（插件 data、系统临时目录、机器人 data 目录，
 *      以及面板里显式追加的目录）之下的文件；
 *   2. 先 realpath 再判断边界 —— 挡住了「根目录里的软链接指向外面」这种逃逸；
 *   3. 必须是普通文件，体积必须在上限之内；
 *   4. 内容必须真的像那么回事：图片看文件头，文本看有没有 NUL 字节。
 *
 * 只靠扩展名判断是不行的：`foo.jpg` 可以是一份只有文字的 txt。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pluginData } from '../config/constant.js'
import { looksLikeText, sniffImageType } from './sniff.js'

export class UnsafePathError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnsafePathError'
    this.code = 'EUNSAFEPATH'
  }
}

/** 默认受信任的根目录；extra 由调用方从配置里补（面板「本机文件白名单」） */
export function trustedRoots(extra = []) {
  const list = [pluginData, os.tmpdir(), path.join(process.cwd(), 'data')]
  if (Array.isArray(extra)) list.push(...extra)
  else if (typeof extra === 'string' && extra.trim()) list.push(...extra.split(/[,，;；\n]+/))

  const out = []
  for (const item of list) {
    const raw = String(item ?? '').trim()
    if (!raw) continue
    let resolved
    try {
      resolved = fs.realpathSync.native(path.resolve(raw))
    } catch {
      continue // 目录不存在就不用管，它本来也读不到东西
    }
    if (!out.includes(resolved)) out.push(resolved)
  }
  return out
}

/** 真实路径是否落在某个根目录之内（按路径分隔符判断，避免 /data 匹配 /database） */
export function isInsideRoots(realPath, roots) {
  for (const root of roots) {
    if (realPath === root) return true
    if (realPath.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return true
  }
  return false
}

/**
 * 把候选路径解析成受信任的真实路径。
 * 传数组时会依次尝试（适配器的相对路径可能相对 cwd，也可能相对 data）。
 *
 * @returns {{realPath: string, size: number}}
 */
export function resolveTrustedFile(candidates, options = {}) {
  const roots = options.roots || trustedRoots(options.extraRoots)
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024
  const allowedExt = options.allowedExt || null

  const tried = []
  for (const candidate of Array.isArray(candidates) ? candidates : [candidates]) {
    const raw = String(candidate ?? '').trim()
    if (!raw) continue
    if (raw.includes('\0')) continue

    let realPath
    try {
      realPath = fs.realpathSync.native(path.resolve(raw))
    } catch {
      tried.push(raw)
      continue
    }

    if (!isInsideRoots(realPath, roots)) {
      tried.push(raw)
      continue
    }

    let stat
    try {
      stat = fs.statSync(realPath)
    } catch {
      tried.push(raw)
      continue
    }
    if (!stat.isFile()) {
      tried.push(raw)
      continue
    }
    if (stat.size === 0 || stat.size > maxBytes) {
      throw new UnsafePathError(`文件体积不在允许范围内（${stat.size} 字节）`)
    }
    if (allowedExt) {
      const ext = path.extname(realPath).toLowerCase()
      if (!allowedExt.includes(ext)) {
        throw new UnsafePathError(`不接受的文件类型：${ext || '(无扩展名)'}`)
      }
    }
    return { realPath, size: stat.size }
  }

  throw new UnsafePathError('文件不在受信任的目录里，或不存在')
}

/** 读一个受信任的图片文件，内容不像图片就拒绝（不是「给个提示继续」） */
export function readTrustedImage(candidates, options = {}) {
  const { realPath } = resolveTrustedFile(candidates, {
    ...options,
    maxBytes: options.maxBytes ?? 8 * 1024 * 1024
  })
  const buffer = fs.readFileSync(realPath)
  const ext = sniffImageType(buffer)
  if (!ext) throw new UnsafePathError('文件内容不是可识别的图片格式')
  return { buffer, ext, realPath }
}

/** 读一个受信任的文本文件（人设导入用），二进制内容直接拒绝 */
export function readTrustedText(candidates, options = {}) {
  const { realPath } = resolveTrustedFile(candidates, {
    ...options,
    maxBytes: options.maxBytes ?? 1024 * 1024,
    allowedExt: options.allowedExt ?? ['.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.csv', '.log', '.ini', '.conf']
  })
  const buffer = fs.readFileSync(realPath)
  if (!looksLikeText(buffer)) throw new UnsafePathError('文件内容不是文本')
  return { text: buffer.toString('utf8').replace(/^\uFEFF/, ''), realPath }
}

export default { trustedRoots, isInsideRoots, resolveTrustedFile, readTrustedImage, readTrustedText, UnsafePathError }
