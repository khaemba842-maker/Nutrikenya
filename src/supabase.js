import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://pnvxiwggidqryqsmghqf.supabase.co'
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBudnhpd2dnaWRxcnlxc21naHFmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0MDM2NzEsImV4cCI6MjA5OTk3OTY3MX0.MTVeA_2jVBOeGrbNA0K_swnkMMhDvJcMKKuv966TH18'

export const supabase = createClient(supabaseUrl, supabaseKey)