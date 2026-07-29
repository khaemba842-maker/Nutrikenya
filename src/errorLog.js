import { supabase } from './supabase'

var lastLogAt = 0

// Fire-and-forget error logging, capped at once per 3s so a tight error loop
// (e.g. a render error firing every frame) can't flood the table or the
// user's connection. Never throws — logging a bug should never cause one.
export function logError(context, error, userId) {
  var now = Date.now()
  if (now - lastLogAt < 3000) return
  lastLogAt = now
  var message = (error && error.message) || String(error)
  var stack = (error && error.stack) || null
  supabase.from('error_logs').insert({
    user_id: userId || null,
    message: message.slice(0, 2000),
    stack: stack ? stack.slice(0, 4000) : null,
    context: context || null,
    url: typeof location !== 'undefined' ? location.href : null,
  }).then(function () {}, function () {})
}

export function installGlobalErrorLogging() {
  window.addEventListener('error', function (e) {
    logError('window.onerror', e.error || e.message)
  })
  window.addEventListener('unhandledrejection', function (e) {
    logError('unhandledrejection', e.reason)
  })
}
