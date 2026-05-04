-- =====================================================================
-- VETSİS — Günlük Görev (Mission) Sistemi Şema Güncellemesi
-- Dosya: 09_daily_missions.sql
-- =====================================================================

-- Mevcut daily_logs tablosunu Görev tablosuna eviriyoruz veya yeni bir tablo açıyoruz
-- Daha temiz olması adına "günlük görevler" için özel 'daily_missions' tablosu oluşturalım:

CREATE TABLE IF NOT EXISTS public.daily_missions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  district_id    INTEGER NOT NULL REFERENCES public.districts(id),
  neighbourhood_id INTEGER NOT NULL REFERENCES public.neighbourhoods(id),
  
  operation_date DATE NOT NULL DEFAULT CURRENT_DATE,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at    TIMESTAMPTZ, -- Doluysa görev bitmiş demektir
  
  -- Görev sonu alınan istatistikler ve notlar
  vaccine_count_applied    INTEGER NOT NULL DEFAULT 0,
  visited_enterprise_count INTEGER NOT NULL DEFAULT 0,
  total_animals_visited    INTEGER NOT NULL DEFAULT 0,
  notes                    TEXT,
  
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_missions_user_date ON public.daily_missions(user_id, operation_date);

-- RLS Politikaları
ALTER TABLE public.daily_missions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "daily_missions_admin_read" ON public.daily_missions;
CREATE POLICY "daily_missions_admin_read" ON public.daily_missions
  FOR SELECT TO authenticated
  USING (
    public.get_my_role() IN ('super_admin', 'province_admin')
    OR (
      public.get_my_role() = 'district_admin'
      AND district_id = public.get_my_district_id()
    )
  );

DROP POLICY IF EXISTS "daily_missions_staff_own" ON public.daily_missions;
CREATE POLICY "daily_missions_staff_own" ON public.daily_missions
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Updated_at Trigger
CREATE TRIGGER trg_daily_missions_updated_at
  BEFORE UPDATE ON public.daily_missions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
