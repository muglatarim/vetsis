-- =====================================================================
-- VETSİS — Günlük Özet Düzeltmesi (Mükerrer Hayvan Sayısı Hatası)
-- Dosya: 11_daily_summary_fix.sql
-- =====================================================================

-- Sorun: Aynı işletmeye ait 2 farklı sürü ziyaret edildiğinde INNER JOIN 
-- yüzünden o işletmenin hayvan sayısı 2 ile çarpılarak özet ekrana yansıyordu.
-- Ayrıca kullanıcı Görevi Bitir ekranında hayvanların tür (Sığır, Keçi vs) bazında 
-- ayrı ayrı toplamını görmek istiyor.

-- Çözüm: Ziyaret edilen sürülerden `enterprise_id` bazında DISTINCT alınarak 
-- eşsiz işletmelerin sadece birer kez toplanmasını sağlamak. Ve ayrı sütunlar dönmek.

DROP FUNCTION IF EXISTS public.get_daily_summary(UUID, UUID, DATE);

CREATE OR REPLACE FUNCTION public.get_daily_summary(
  p_campaign_id  UUID,
  p_user_id      UUID,
  p_date         DATE
)
RETURNS TABLE (
  visited_enterprise_count INTEGER,
  total_animals_count      INTEGER,
  sigir_total              INTEGER,
  manda_total              INTEGER,
  koyun_total              INTEGER,
  keci_total               INTEGER
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH dist_enterprises AS (
    -- Aynı işletmenin birden fazla sürüsü olsa da SELECT DISTINCT e.id sayesinde 
    -- o işletmenin satırı SADECE 1 KEZ alınır.
    SELECT DISTINCT 
      e.id, 
      e.sigir_count, 
      e.manda_count, 
      e.koyun_count, 
      e.keci_count
    FROM public.visit_logs vl
    JOIN public.herds h ON h.id = vl.herd_id
    JOIN public.enterprises e ON e.id = h.enterprise_id
    WHERE
      vl.campaign_id = p_campaign_id
      AND vl.user_id = p_user_id
      AND vl.operation_date = p_date
      AND vl.status = 'visited'
  )
  SELECT
    COUNT(id)::INTEGER AS visited_enterprise_count,
    COALESCE(SUM(sigir_count + manda_count + koyun_count + keci_count), 0)::INTEGER AS total_animals_count,
    COALESCE(SUM(sigir_count), 0)::INTEGER AS sigir_total,
    COALESCE(SUM(manda_count), 0)::INTEGER AS manda_total,
    COALESCE(SUM(koyun_count), 0)::INTEGER AS koyun_total,
    COALESCE(SUM(keci_count), 0)::INTEGER AS keci_total
  FROM dist_enterprises;
END;
$$;
