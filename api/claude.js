import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://pnvxiwggidqryqsmghqf.supabase.co'
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBudnhpd2dnaWRxcnlxc21naHFmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0MDM2NzEsImV4cCI6MjA5OTk3OTY3MX0.MTVeA_2jVBOeGrbNA0K_swnkMMhDvJcMKKuv966TH18'

const SCAN_MODEL = 'claude-haiku-4-5'
const PLAN_MODEL = 'claude-sonnet-5'
const QUICKADD_MODEL = 'claude-haiku-4-5'

const KENYAN_FOOD_REFERENCE = 'Kenyan food reference: Ugali 1cup=370kcal/1.2p/84c/1.6f | Sukuma Wiki 100g=35kcal/3.3p | Nyama Choma 100g=250kcal/26p/16f | Githeri 1cup=142kcal/7p/24c | Chapati 1pc=230kcal/5p/32c/9f | Chicken 100g=165kcal/25p/7f | Eggs 1=70kcal/6p/5f | Rice 1cup=130kcal/2.7p/28c | Tilapia 100g=128kcal/26p/3f.'

const SCAN_SYSTEM = 'You are a precision Kenyan nutrition AI. Analyze food images.\n' + KENYAN_FOOD_REFERENCE

const QUICKADD_SYSTEM = 'You are a precision Kenyan nutrition AI. Parse a free-text meal description into one or more distinct food items, each with an estimated portion and macros. Split combined descriptions ("2 eggs and a chapati") into separate items.\n' + KENYAN_FOOD_REFERENCE

const SCAN_SCHEMA = {
  type: 'object',
  properties: {
    food: { type: 'string' },
    portion: { type: 'string' },
    calories: { type: 'number' },
    protein: { type: 'number' },
    carbs: { type: 'number' },
    fat: { type: 'number' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: 'string' },
    budgetKES: { type: 'number' },
  },
  required: ['food', 'portion', 'calories', 'protein', 'carbs', 'fat', 'confidence', 'notes', 'budgetKES'],
  additionalProperties: false,
}

const QUICKADD_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          food: { type: 'string' },
          portion: { type: 'string' },
          calories: { type: 'number' },
          protein: { type: 'number' },
          carbs: { type: 'number' },
          fat: { type: 'number' },
        },
        required: ['food', 'portion', 'calories', 'protein', 'carbs', 'fat'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    days: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          day: { type: 'string' },
          breakfast: { type: 'string' },
          lunch: { type: 'string' },
          dinner: { type: 'string' },
          calories: { type: 'number' },
          protein: { type: 'number' },
          tip: { type: 'string' },
        },
        required: ['day', 'breakfast', 'lunch', 'dinner', 'calories', 'protein', 'tip'],
        additionalProperties: false,
      },
    },
  },
  required: ['days'],
  additionalProperties: false,
}

async function authenticate(req) {
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return null
  const supabase = createClient(supabaseUrl, supabaseAnonKey)
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  return data.user
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const user = await authenticate(req)
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { action } = req.body || {}
  let anthropicBody

  if (action === 'scan') {
    const { mediaType, data } = req.body.image || {}
    if (!mediaType || !data) return res.status(400).json({ error: 'Missing image' })
    anthropicBody = {
      model: SCAN_MODEL,
      max_tokens: 700,
      system: SCAN_SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
          { type: 'text', text: 'Identify this food and estimate nutrition. Consider typical Kenyan portions.' },
        ],
      }],
      output_config: { format: { type: 'json_schema', schema: SCAN_SCHEMA } },
    }
  } else if (action === 'quickadd') {
    const { description } = req.body || {}
    if (!description || typeof description !== 'string' || !description.trim()) {
      return res.status(400).json({ error: 'Missing description' })
    }
    anthropicBody = {
      model: QUICKADD_MODEL,
      max_tokens: 600,
      system: QUICKADD_SYSTEM,
      messages: [{ role: 'user', content: description.slice(0, 500) }],
      output_config: { format: { type: 'json_schema', schema: QUICKADD_SCHEMA } },
    }
  } else if (action === 'plan') {
    const { goal, calories, protein, carbs, fat, restrictions } = req.body.targets || {}
    if (!goal || !calories) return res.status(400).json({ error: 'Missing targets' })
    anthropicBody = {
      model: PLAN_MODEL,
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `Generate a 3-day Kenyan meal plan. Goal: ${goal}. Cal: ${calories}/day. Protein: ${protein}g. Carbs: ${carbs}g. Fat: ${fat}g. Restrictions: ${restrictions}. ONLY authentic Kenyan foods.`,
      }],
      output_config: { format: { type: 'json_schema', schema: PLAN_SCHEMA } },
    }
  } else {
    return res.status(400).json({ error: 'Invalid action' })
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicBody),
    })

    const data = await response.json()
    return res.status(response.status).json(data)
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' })
  }
}
