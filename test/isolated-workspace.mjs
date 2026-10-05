/** 仅复制源码与默认配置，所有会写数据的检查都在临时副本运行。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export function runIsolated(script) {
  if (process.argv[2] === '--isolated') return
  const source = path.resolve(path.dirname(script), '..')
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'DeepChat-check-'))
  let status = 1
  try {
    for (const name of ['model', 'apps', 'config', 'resources', 'test', 'index.js', 'package.json', 'guoba.support.js', '.gitignore', 'LICENSE', 'DISCLAIMER.md', 'README.md']) {
      fs.cpSync(path.join(source, name), path.join(temporary, name), { recursive: true })
    }
    fs.mkdirSync(path.join(temporary, 'data'))
    fs.copyFileSync(path.join(source, 'data/cfg_default.json'), path.join(temporary, 'data/cfg_default.json'))
    const result = spawnSync(process.execPath, [path.join(temporary, 'test', path.basename(script)), '--isolated'], {
      cwd: temporary, stdio: 'inherit', timeout: 120000
    })
    if (result.error) console.error(result.error.message)
    status = result.status ?? 1
  } finally {
    const target = path.resolve(temporary)
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('DeepChat-check-')) throw new Error('临时目录边界不符')
    fs.rmSync(target, { recursive: true, force: true })
  }
  process.exit(status)
}
