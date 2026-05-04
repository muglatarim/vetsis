import { createClient } from '@supabase/supabase-js'

const supabaseUrl  = import.meta.env.VITE_SUPABASE_URL
const supabaseKey  = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Supabase ortam değişkenleri eksik! .env dosyasını kontrol edin.')
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: localStorage,
  },
  realtime: {
    params: { eventsPerSecond: 10 }
  }
})

// Realtime kanalı — visit_logs tablosu (canlı harita güncellemeleri)
export const createVisitChannel = (campaignId, onUpdate) => {
  return supabase
    .channel(`visit_logs:campaign_${campaignId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'visit_logs',
        filter: `campaign_id=eq.${campaignId}`
      },
      onUpdate
    )
    .subscribe()
}
