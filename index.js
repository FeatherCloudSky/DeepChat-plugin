/**
 * DeepChat-plugin 入口。
 *
 * 与大多数 Yunzai 插件一样：自动扫描 apps/ 下的所有 .js，
 * 把每个模块的第一个导出收集起来挂到 apps 上。
 */
import fs from 'node:fs'
import { pluginApplications, pluginName } from './config/constant.js'

const files = fs.readdirSync(pluginApplications).filter((file) => file.endsWith('.js'))

const loaded = await Promise.allSettled(files.map((file) => import(`./apps/${file}`)))

const apps = {}

files.forEach((file, i) => {
  const name = file.replace(/\.js$/, '')
  const result = loaded[i]

  if (result.status !== 'fulfilled') {
    logger.error(`[${pluginName}] 载入 ${logger.red(name)} 失败`)
    logger.error(result.reason)
    return
  }

  const firstExport = result.value[Object.keys(result.value)[0]]
  if (!firstExport) {
    logger.warn(`[${pluginName}] ${name} 没有导出任何插件类，已跳过`)
    return
  }

  apps[name] = firstExport
})

logger.mark(`[${pluginName}] 载入完毕，可用命令：#DeepHelp`)

export { apps }
