-- =====================================================================
-- VETSİS — Ziyaret Logları Güncelleme (RLS) Yaması
-- Dosya: 10_visit_logs_rls_fix.sql
-- =====================================================================

-- Sorun: A kişisi (GPS veya elle) sürü yaklaştığında log 'pending' veya 'detected' olarak 
-- kendi adına açılıyor. Daha sonra B kişisi veya kendisi 'Ziyaret Edildi' demek istediğinde,
-- "Sadece kendi loglarını güncelleyebilirsin" şeklindeki sert RLS kuralına takılarak yetkisiz 
-- işlem uyarısı alıp güncelleme yapamıyordu (sessizce buton tıklanmıyordu).

-- Çözüm: Kampanya ekibindeki (campaign_staff) herkes, o kampanyaya ait logları güncelleyebilir
-- Ayrıca Süper Admin ve İl/İlçe Adminleri de güncelleyebilir.

-- 1) Eski personeller sadece kendisininkini düzenler kuralını sil.
DROP POLICY IF EXISTS "visit_logs_staff_update" ON public.visit_logs;

-- 2) Kampanyada aktif olan herkes güncelleyebilir kuralını koy.
CREATE POLICY "visit_logs_staff_update" ON public.visit_logs
  FOR UPDATE TO authenticated
  USING (
    campaign_id IN (
      SELECT campaign_id FROM public.campaign_staff 
      WHERE user_id = auth.uid() AND is_active = TRUE
    )
  )
  WITH CHECK (
    campaign_id IN (
      SELECT campaign_id FROM public.campaign_staff 
      WHERE user_id = auth.uid() AND is_active = TRUE
    )
  );

-- 3) Adminler ve yöneticilerin de gerekirse güncelleyebilmesi için (Eski sistemde yoktu):
DROP POLICY IF EXISTS "visit_logs_admin_update" ON public.visit_logs;
CREATE POLICY "visit_logs_admin_update" ON public.visit_logs
  FOR UPDATE TO authenticated
  USING (
    public.get_my_role() IN ('super_admin', 'province_admin')
    OR (
      public.get_my_role() = 'district_admin'
      AND campaign_id IN (
        SELECT id FROM public.campaigns WHERE district_id = public.get_my_district_id()
      )
    )
  )
  WITH CHECK (
    public.get_my_role() IN ('super_admin', 'province_admin')
    OR (
      public.get_my_role() = 'district_admin'
      AND campaign_id IN (
        SELECT id FROM public.campaigns WHERE district_id = public.get_my_district_id()
      )
    )
  );
