var KEY = 'nutrikenya_offline_queue_v1'

function readQueue () {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]') } catch (e) { return [] }
}
function writeQueue (q) {
  try { localStorage.setItem(KEY, JSON.stringify(q)) } catch (e) {}
  notify()
}

var listeners = []
function notify () {
  var n = readQueue().length
  listeners.forEach(function (l) { l(n) })
}
// Lets UI (e.g. a "3 changes waiting to sync" line in Profile) react to the
// queue growing or draining without polling.
export function onQueueChange (fn) {
  listeners.push(fn)
  return function () { listeners = listeners.filter(function (l) { return l !== fn }) }
}

// Queues a write for later. `label` must match a handler registered via
// registerHandler — the actual network call happens on flush, not here.
export function queueWrite (label, payload) {
  var q = readQueue()
  var item = { id: Date.now() + '-' + Math.random().toString(36).slice(2), label: label, payload: payload, ts: Date.now() }
  q.push(item)
  writeQueue(q)
  return item.id
}

// Removes queued writes matching matchFn — used when the user undoes
// something locally (e.g. deletes a food they just logged) before it ever
// reached the server, so the queued write doesn't resurrect it later.
export function cancelQueued (matchFn) {
  var q = readQueue()
  var next = q.filter(function (item) { return !matchFn(item) })
  var removed = next.length !== q.length
  writeQueue(next)
  return removed
}

export function queueLength () { return readQueue().length }

var handlers = {}
export function registerHandler (label, fn) { handlers[label] = fn }

var flushing = false
// Replays queued writes in order, stopping at the first failure so a later
// write can never land before an earlier one it might depend on. Safe to
// call repeatedly — no-ops while already flushing or while offline.
export async function flushQueue () {
  if (flushing || !navigator.onLine) return
  flushing = true
  try {
    var q = readQueue()
    while (q.length > 0) {
      var item = q[0]
      var fn = handlers[item.label]
      if (!fn) { q.shift(); writeQueue(q); q = readQueue(); continue }
      try {
        var res = await fn(item.payload)
        if (res && res.error) throw res.error
        q.shift(); writeQueue(q); q = readQueue()
      } catch (e) {
        break
      }
    }
  } finally {
    flushing = false
  }
}

export function installOnlineFlush () {
  window.addEventListener('online', flushQueue)
  if (navigator.onLine) flushQueue()
}
