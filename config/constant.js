import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 用 import.meta.url 定位插件目录，而不是 process.cwd()。
// 这样插件被放在任何位置都能正确定位自己的 data/ 和 resources/。
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginName = path.basename(pluginRoot)

const pluginData = path.join(pluginRoot, 'data')
const pluginResources = path.join(pluginRoot, 'resources')
const pluginApplications = path.join(pluginRoot, 'apps')

export {
  pluginName,
  pluginRoot,
  pluginData,
  pluginResources,
  pluginApplications
}
