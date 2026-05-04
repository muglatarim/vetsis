-- ============================================================
-- RLS Infinite Recursion Hatasını Çözme Yaması
-- ============================================================

-- RLS politikaları birbirini çapraz olarak çağırdığında (campaigns -> campaign_staff -> campaigns)
-- PostgreSQL "infinite recursion" (Sonsuz döngü) hatası fırlatır.
-- Bunu çözmek için `campaigns` tablosuna erişimi RLS kontörünün dışına çıkaran Security Definer
-- bir fonksiyon oluşturuyoruz ve kontrolü buradan yaptırıyoruz.

CREATE OR REPLACE FUNCTION public.get_district_campaign_ids(p_district_id INTEGER)
RETURNS TABLE(id UUID) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
  SELECT id FROM public.campaigns WHERE district_id = p_district_id;
$$;

-- 1. Campaign Staff
DROP POLICY IF EXISTS "campaign_staff_admin" ON campaign_staff;
CREATE POLICY "campaign_staff_admin" ON campaign_staff
  FOR ALL TO authenticated
  USING (
    public.get_my_role() IN ('super_admin', 'province_admin')
    OR (
      public.get_my_role() = 'district_admin'
      AND campaign_id IN (
        SELECT id FROM public.get_district_campaign_ids(public.get_my_district_id())
      )
    )
  );

-- 2. Campaign Species
DROP POLICY IF EXISTS "campaign_species_admin" ON campaign_species;
CREATE POLICY "campaign_species_admin" ON campaign_species
  FOR ALL TO authenticated
  USING (
    public.get_my_role() IN ('super_admin', 'province_admin')
    OR (
      campaign_id IN (
        SELECT id FROM public.get_district_campaign_ids(public.get_my_district_id())
      )
    )
  );

-- 3. Visit Logs (Ziyaretler)
DROP POLICY IF EXISTS "visit_logs_admin_read" ON visit_logs;
CREATE POLICY "visit_logs_admin_read" ON visit_logs
  FOR SELECT TO authenticated
  USING (
    public.get_my_role() IN ('super_admin', 'province_admin')
    OR (
      public.get_my_role() = 'district_admin'
      AND campaign_id IN (
        SELECT id FROM public.get_district_campaign_ids(public.get_my_district_id())
      )
    )
  );
  
-- 4. Daily Logs (Günlük Raporlar)
DROP POLICY IF EXISTS "daily_logs_admin_read" ON daily_logs;
CREATE POLICY "daily_logs_admin_read" ON daily_logs
  FOR SELECT TO authenticated
  USING (
    public.get_my_role() IN ('super_admin', 'province_admin')
    OR (
      public.get_my_role() = 'district_admin'
      AND campaign_id IN (
        SELECT id FROM public.get_district_campaign_ids(public.get_my_district_id())
      )
    )
  );
