-- =====================================================================
-- VETSİS — Row Level Security Politikaları
-- Dosya: 02_rls_policies.sql
-- Açıklama: Rol bazlı veri izolasyonu
-- NOT: 01_schema.sql çalıştırıldıktan sonra çalıştırın.
-- =====================================================================

-- ============================================================
-- RLS ETKİNLEŞTİR
-- ============================================================
ALTER TABLE provinces         ENABLE ROW LEVEL SECURITY;
ALTER TABLE districts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE neighbourhoods    ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprises       ENABLE ROW LEVEL SECURITY;
ALTER TABLE herds             ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns         ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_species  ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_staff    ENABLE ROW LEVEL SECURITY;
ALTER TABLE visit_logs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_logs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE temp_enterprises  ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- YARDIMCI FONKSİYONLAR (SECURITY DEFINER — RLS'yi bypass eder)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS user_role LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION public.get_my_district_id()
RETURNS INTEGER LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
  SELECT district_id FROM public.profiles WHERE id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION public.get_my_province_id()
RETURNS SMALLINT LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
  SELECT province_id FROM public.profiles WHERE id = auth.uid()
$$;

-- Kullanıcının aktif olarak davet edildiği kampanyaların district_id listesi
CREATE OR REPLACE FUNCTION public.get_my_campaign_district_ids()
RETURNS TABLE(district_id INTEGER) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
  SELECT DISTINCT c.district_id
  FROM public.campaign_staff cs
  JOIN public.campaigns c ON c.id = cs.campaign_id
  WHERE cs.user_id = auth.uid()
    AND cs.is_active = TRUE
    AND c.status = 'active'
$$;

-- ============================================================
-- COĞRAFİ TABLOLAR — Tüm yetkili kullanıcılar okuyabilir
-- ============================================================
DROP POLICY IF EXISTS "provinces_read" ON provinces;
CREATE POLICY "provinces_read" ON provinces
  FOR SELECT TO authenticated USING (TRUE);

DROP POLICY IF EXISTS "districts_read" ON districts;
CREATE POLICY "districts_read" ON districts
  FOR SELECT TO authenticated USING (TRUE);

DROP POLICY IF EXISTS "neighbourhoods_read" ON neighbourhoods;
CREATE POLICY "neighbourhoods_read" ON neighbourhoods
  FOR SELECT TO authenticated USING (TRUE);

-- ============================================================
-- PROFİLLER
-- ============================================================

-- Herkes kendi profilini okuyabilir
DROP POLICY IF EXISTS "profiles_select_own" ON profiles;
CREATE POLICY "profiles_select_own" ON profiles
  FOR SELECT TO authenticated USING (id = auth.uid());

-- Süper Admin ve İl Yöneticisi tüm profilleri okuyabilir
DROP POLICY IF EXISTS "profiles_select_upper_admin" ON profiles;
CREATE POLICY "profiles_select_upper_admin" ON profiles
  FOR SELECT TO authenticated
  USING (public.get_my_role() IN ('super_admin', 'province_admin'));

-- İlçe Yöneticisi sadece kendi ilçesindeki personelleri görebilir
DROP POLICY IF EXISTS "profiles_select_district_admin" ON profiles;
CREATE POLICY "profiles_select_district_admin" ON profiles
  FOR SELECT TO authenticated
  USING (
    public.get_my_role() = 'district_admin'
    AND district_id = public.get_my_district_id()
  );

-- Herkes kendi profilini güncelleyebilir (rol değiştiremez)
DROP POLICY IF EXISTS "profiles_update_own" ON profiles;
CREATE POLICY "profiles_update_own" ON profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    -- Rol değişikliğine izin yok (sadece super_admin aşağıda yapabilir)
    AND role = (SELECT role FROM public.profiles WHERE id = auth.uid())
  );

-- Süper Admin tüm profilleri güncelleyebilir (rol atama dahil)
DROP POLICY IF EXISTS "profiles_update_super_admin" ON profiles;
CREATE POLICY "profiles_update_super_admin" ON profiles
  FOR UPDATE TO authenticated
  USING (public.get_my_role() = 'super_admin');

-- ============================================================
-- İŞLETMELER (ENTERPRISES)
-- ============================================================

-- Süper Admin: Tam erişim
DROP POLICY IF EXISTS "enterprises_super_admin" ON enterprises;
CREATE POLICY "enterprises_super_admin" ON enterprises
  FOR ALL TO authenticated
  USING (public.get_my_role() = 'super_admin')
  WITH CHECK (public.get_my_role() = 'super_admin');

-- İl Yöneticisi: Kendi ilindeki tüm ilçelerin işletmeleri
DROP POLICY IF EXISTS "enterprises_province_admin" ON enterprises;
CREATE POLICY "enterprises_province_admin" ON enterprises
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'province_admin'
    AND district_id IN (
      SELECT id FROM districts WHERE province_id = public.get_my_province_id()
    )
  )
  WITH CHECK (
    public.get_my_role() = 'province_admin'
    AND district_id IN (
      SELECT id FROM districts WHERE province_id = public.get_my_province_id()
    )
  );

-- İlçe Yöneticisi: Sadece kendi ilçesi
DROP POLICY IF EXISTS "enterprises_district_admin" ON enterprises;
CREATE POLICY "enterprises_district_admin" ON enterprises
  FOR ALL TO authenticated
  USING (
    public.get_my_role() = 'district_admin'
    AND district_id = public.get_my_district_id()
  )
  WITH CHECK (
    public.get_my_role() = 'district_admin'
    AND district_id = public.get_my_district_id()
  );

-- Saha Personeli: Davet edildiği kampanyanın ilçesindeki işletmeleri okuyabilir
-- İşletme listesini görebilir, ama yazamaz/silemez.
DROP POLICY IF EXISTS "enterprises_field_staff_read" ON enterprises;
CREATE POLICY "enterprises_field_staff_read" ON enterprises
  FOR SELECT TO authenticated
  USING (
    public.get_my_role() = 'field_staff'
    AND district_id IN (SELECT district_id FROM public.get_my_campaign_district_ids())
  );

-- ============================================================
-- SÜRÜLER (HERDS)
-- ============================================================

-- Admin hiyerarşisi: Tam erişim
DROP POLICY IF EXISTS "herds_admin_all" ON herds;
CREATE POLICY "herds_admin_all" ON herds
  FOR ALL TO authenticated
  USING (
    public.get_my_role() IN ('super_admin', 'province_admin')
    OR (
      public.get_my_role() = 'district_admin'
      AND district_id = public.get_my_district_id()
    )
  );

-- Saha Personeli: Kampanya ilçesindeki sürüleri okuyabilir
DROP POLICY IF EXISTS "herds_field_staff_read" ON herds;
CREATE POLICY "herds_field_staff_read" ON herds
  FOR SELECT TO authenticated
  USING (
    public.get_my_role() = 'field_staff'
    AND district_id IN (SELECT district_id FROM public.get_my_campaign_district_ids())
  );

-- Saha Personeli: Kampanya ilçesine yeni sürü (konum) ekleyebilir
DROP POLICY IF EXISTS "herds_field_staff_insert" ON herds;
CREATE POLICY "herds_field_staff_insert" ON herds
  FOR INSERT TO authenticated
  WITH CHECK (
    public.get_my_role() = 'field_staff'
    AND district_id IN (SELECT district_id FROM public.get_my_campaign_district_ids())
  );

-- Saha Personeli: Kendi eklediği sürü konumunu güncelleyebilir
DROP POLICY IF EXISTS "herds_field_staff_update" ON herds;
CREATE POLICY "herds_field_staff_update" ON herds
  FOR UPDATE TO authenticated
  USING (
    public.get_my_role() = 'field_staff'
    AND district_id IN (SELECT district_id FROM public.get_my_campaign_district_ids())
  );

-- ============================================================
-- KAMPANYALAR (CAMPAIGNS)
-- ============================================================

-- Admin hiyerarşisi: Kampanya yönetimi
DROP POLICY IF EXISTS "campaigns_admin_crud" ON campaigns;
CREATE POLICY "campaigns_admin_crud" ON campaigns
  FOR ALL TO authenticated
  USING (
    public.get_my_role() IN ('super_admin', 'province_admin')
    OR (
      public.get_my_role() = 'district_admin'
      AND district_id = public.get_my_district_id()
    )
  );

-- Saha Personeli: Sadece davet edildiği kampanyaları görebilir
DROP POLICY IF EXISTS "campaigns_field_staff_read" ON campaigns;
CREATE POLICY "campaigns_field_staff_read" ON campaigns
  FOR SELECT TO authenticated
  USING (
    id IN (
      SELECT campaign_id FROM campaign_staff
      WHERE user_id = auth.uid() AND is_active = TRUE
    )
  );

-- ============================================================
-- KAMPANYA TÜRLERİ (CAMPAIGN_SPECIES)
-- ============================================================
DROP POLICY IF EXISTS "campaign_species_admin" ON campaign_species;
CREATE POLICY "campaign_species_admin" ON campaign_species
  FOR ALL TO authenticated
  USING (
    public.get_my_role() IN ('super_admin', 'province_admin')
    OR (
      campaign_id IN (
        SELECT id FROM campaigns
        WHERE district_id = public.get_my_district_id()
      )
    )
  );

DROP POLICY IF EXISTS "campaign_species_staff_read" ON campaign_species;
CREATE POLICY "campaign_species_staff_read" ON campaign_species
  FOR SELECT TO authenticated
  USING (
    campaign_id IN (
      SELECT campaign_id FROM campaign_staff
      WHERE user_id = auth.uid() AND is_active = TRUE
    )
  );

-- ============================================================
-- KAMPANYA PERSONELİ (CAMPAIGN_STAFF)
-- ============================================================

-- İlçe Yöneticisi: Kampanya personelini yönetebilir
DROP POLICY IF EXISTS "campaign_staff_admin" ON campaign_staff;
CREATE POLICY "campaign_staff_admin" ON campaign_staff
  FOR ALL TO authenticated
  USING (
    public.get_my_role() IN ('super_admin', 'province_admin')
    OR (
      public.get_my_role() = 'district_admin'
      AND campaign_id IN (
        SELECT id FROM campaigns WHERE district_id = public.get_my_district_id()
      )
    )
  );

-- Personel: Kendi davet kayıtlarını görebilir
DROP POLICY IF EXISTS "campaign_staff_self_read" ON campaign_staff;
CREATE POLICY "campaign_staff_self_read" ON campaign_staff
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- ============================================================
-- ZİYARET LOGLARI (VISIT_LOGS)
-- ============================================================

-- Admin: Kendi ilçesinin kampanyalarına ait logları görebilir
DROP POLICY IF EXISTS "visit_logs_admin_read" ON visit_logs;
CREATE POLICY "visit_logs_admin_read" ON visit_logs
  FOR SELECT TO authenticated
  USING (
    public.get_my_role() IN ('super_admin', 'province_admin')
    OR (
      public.get_my_role() = 'district_admin'
      AND campaign_id IN (
        SELECT id FROM campaigns WHERE district_id = public.get_my_district_id()
      )
    )
  );

-- Kampanya Personeli: Aynı kampanyadaki TÜM personelin loglarını görebilir
-- (Realtime ile aynı mahalledeki hekimler birbirinin yeşil işaretlemeleri görsün)
DROP POLICY IF EXISTS "visit_logs_staff_read" ON visit_logs;
CREATE POLICY "visit_logs_staff_read" ON visit_logs
  FOR SELECT TO authenticated
  USING (
    campaign_id IN (
      SELECT campaign_id FROM campaign_staff
      WHERE user_id = auth.uid() AND is_active = TRUE
    )
  );

-- Personel: Sadece kendi kayıtlarını ekleyebilir
DROP POLICY IF EXISTS "visit_logs_staff_insert" ON visit_logs;
CREATE POLICY "visit_logs_staff_insert" ON visit_logs
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND campaign_id IN (
      SELECT campaign_id FROM campaign_staff
      WHERE user_id = auth.uid() AND is_active = TRUE
    )
  );

-- Personel: Sadece kendi kayıtlarını güncelleyebilir
DROP POLICY IF EXISTS "visit_logs_staff_update" ON visit_logs;
CREATE POLICY "visit_logs_staff_update" ON visit_logs
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ============================================================
-- GÜNLÜK MESAİ LOGLARI (DAILY_LOGS)
-- ============================================================

-- Admin: Okuma
DROP POLICY IF EXISTS "daily_logs_admin_read" ON daily_logs;
CREATE POLICY "daily_logs_admin_read" ON daily_logs
  FOR SELECT TO authenticated
  USING (
    public.get_my_role() IN ('super_admin', 'province_admin')
    OR (
      public.get_my_role() = 'district_admin'
      AND campaign_id IN (
        SELECT id FROM campaigns WHERE district_id = public.get_my_district_id()
      )
    )
  );

-- Personel: Sadece kendi günlük loglarını yazabilir/okuyabilir
DROP POLICY IF EXISTS "daily_logs_staff_own" ON daily_logs;
CREATE POLICY "daily_logs_staff_own" ON daily_logs
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ============================================================
-- GEÇİCİ İŞLETMELER (TEMP_ENTERPRISES)
-- ============================================================
DROP POLICY IF EXISTS "temp_enterprises_access" ON temp_enterprises;
CREATE POLICY "temp_enterprises_access" ON temp_enterprises
  FOR ALL TO authenticated
  USING (
    public.get_my_role() IN ('super_admin', 'province_admin')
    OR district_id = public.get_my_district_id()
  );
