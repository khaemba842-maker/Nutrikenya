import { createClient } from '@supabase/supabase-js'
import webpush from 'web-push'

const supabaseUrl = 'https://pnvxiwggidqryqsmghqf.supabase.co'

// Kenya is a single timezone (EAT, UTC+3) for effectively the whole user
// base, so "today" for a daily reminder is computed once here rather than
// per-user — same rationale as localDateStr() on the client.
function todayEAT() {
  var eat = new Date(Date.now() + 3 * 60 * 60 * 1000)
  return eat.toISOString().slice(0, 10)
}

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_PUBLIC_KEY) {
    return res.status(500).json({ error: 'Missing required env vars' })
  }

  webpush.setVapidDetails('mailto:privacy@aiscope.online', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY)
  const supabase = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY)

  const today = todayEAT()
  const { data: loggedToday, error: logErr } = await supabase.from('food_logs').select('user_id').eq('date', today)
  if (logErr) return res.status(500).json({ error: logErr.message })
  const loggedUserIds = new Set((loggedToday || []).map((r) => r.user_id))

  const { data: subs, error: subErr } = await supabase.from('push_subscriptions').select('id,user_id,endpoint,p256dh,auth')
  if (subErr) return res.status(500).json({ error: subErr.message })

  const targets = (subs || []).filter((s) => !loggedUserIds.has(s.user_id))
  const payload = JSON.stringify({
    title: 'NutriKenya',
    body: "You haven't logged any meals today — tap to catch up.",
    url: '/',
  })

  let sent = 0
  let removed = 0
  await Promise.all(
    targets.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload
        )
        sent++
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          await supabase.from('push_subscriptions').delete().eq('id', s.id)
          removed++
        } else {
          console.error('push send failed:', e.message)
        }
      }
    })
  )

  return res.status(200).json({ eligible: targets.length, sent, removedExpired: removed })
}
