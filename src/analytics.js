var POSTHOG_KEY = 'phc_osfNuAksfKnRVuZf9i4fadQqD5DN6XeqDqRWqPw6ZiNG'
var posthog = null
var queue = []

// posthog-js adds real weight to the bundle (~75KB gzipped) — loaded lazily
// via dynamic import so it never blocks first paint. Calls made before it
// resolves (e.g. onboarding_started firing almost immediately) are queued
// and replayed once ready, rather than silently dropped.
export function initAnalytics () {
  if (posthog || typeof window === 'undefined') return
  import('posthog-js').then(function (mod) {
    posthog = mod.default
    posthog.init(POSTHOG_KEY, {
      api_host: 'https://us.i.posthog.com',
      defaults: '2026-05-30',
      capture_pageview: false, // SPA with tab-based navigation, not real routes — screens are tracked manually via track('screen_viewed', ...)
      autocapture: false, // named events only — avoids capturing noise and keeps this precise rather than blind click-tracking
      disable_session_recording: true, // not needed for the funnel/retention/failure metrics this is instrumented for, and mobile data cost is a real constraint here
    })
    queue.forEach(function (fn) { fn(posthog) })
    queue = []
  })
}

function run (fn) {
  if (posthog) fn(posthog)
  else queue.push(fn)
}

export function track (event, props) {
  run(function (ph) { ph.capture(event, props) })
}

export function identifyUser (userId, props) {
  if (!userId) return
  run(function (ph) { ph.identify(userId, props) })
}

export function resetAnalytics () {
  run(function (ph) { ph.reset() })
}
