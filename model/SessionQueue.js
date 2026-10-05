/** 同一会话串行处理，直到分条回复结束；不同会话互不阻塞。 */
export class QueueFullError extends Error {}

const sessions = new Map()
let barrier = Promise.resolve()

export function runInSession(key, task, { limit = 5, dropIfBusy = false, control = false } = {}) {
  let entry = sessions.get(key)
  if (entry && dropIfBusy) return Promise.resolve(false)
  if (entry && !control && entry.size >= limit) return Promise.reject(new QueueFullError('会话队列已满'))
  if (!entry) {
    entry = { tail: Promise.resolve(), size: 0 }
    sessions.set(key, entry)
  }
  entry.size++
  const gate = barrier
  const result = entry.tail.then(() => gate).then(task)
  const settled = result.finally(() => {
    entry.size--
    if (entry.size === 0 && sessions.get(key) === entry) sessions.delete(key)
  })
  entry.tail = settled.catch(() => {})
  return settled
}

/** 全局清空等待此前任务结束，后续请求等待清空完成。 */
export function runExclusive(task) {
  const result = Promise.all([barrier, ...[...sessions.values()].map((entry) => entry.tail)]).then(task)
  barrier = result.catch(() => {})
  return result
}

export default { run: runInSession, exclusive: runExclusive }
