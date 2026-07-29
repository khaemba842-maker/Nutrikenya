import { supabase } from './supabase'

// Public by design — the matching private key stays server-side only
// (Vercel env var), used to sign outgoing pushes so browsers can verify
// they came from this app.
export var VAPID_PUBLIC_KEY = 'BMT2-b-l4rlJ9_t2eVrDVg7zdrvBfkUlc3C28h5jRszdfQiO1XeOGouk2wKCAK4IgQIcczKVj0-M5h9SwMXM8M0'

export function pushSupported () {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window
}

function urlBase64ToUint8Array (base64String) {
  var padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  var rawData = atob(base64)
  var outputArray = new Uint8Array(rawData.length)
  for (var i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i)
  return outputArray
}

export async function getPushSubscription () {
  if (!pushSupported()) return null
  var reg = await navigator.serviceWorker.ready
  return reg.pushManager.getSubscription()
}

export async function subscribeToPush (userId) {
  if (!pushSupported()) throw new Error('Push notifications are not supported on this browser.')
  var permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notification permission was not granted.')
  var reg = await navigator.serviceWorker.ready
  var sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  })
  var json = sub.toJSON()
  var res = await supabase.from('push_subscriptions').upsert({
    user_id: userId,
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
  }, { onConflict: 'endpoint' })
  if (res.error) throw res.error
  return sub
}

export async function unsubscribeFromPush () {
  var sub = await getPushSubscription()
  if (!sub) return
  var endpoint = sub.endpoint
  await sub.unsubscribe()
  await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint)
}
