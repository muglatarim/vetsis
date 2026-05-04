-- =====================================================================
-- VETSİS — Admin Ekleme Yetkisi ve Tür Filtresi Yaması
-- Dosya: 12_admin_and_filter_fix.sql
-- =====================================================================

-- 1) Adminlerin "Ziyaret Edildi" diyerek sıfırdan log EKLEYEBİLMESİ (INSERT) için:
DROP POLICY IF EXISTS "visit_logs_admin_insert" ON public.visit_logs;
CREATE POLICY "visit_logs_admin_insert" ON public.visit_logs
  FOR INSERT TO authenticated
  WITH CHECK (
    public.get_my_role() IN ('super_admin', 'province_admin')
    OR (
      public.get_my_role() = 'district_admin'
      AND campaign_id IN (
        SELECT id FROM public.campaigns WHERE district_id = public.get_my_district_id()
      )
    )
  );


-- 2) Haritada İlgisiz Türlerin Gözükmemesi İçin "get_campaign_herds" Filtresi:
-- Eskiden e.sigir_count > 0 ise işletmenin tüm sürüleri çekiliyordu.
-- Artık sadece sürünün kendisinde (h.species) o tür varsa haritada çıkacak.

CREATE OR REPLACE FUNCTION public.get_campaign_herds(
  p_campaign_id UUID,
  p_species     TEXT[]
)
RETURNS TABLE (
  herd_id           UUID,
  enterprise_id     TEXT,
  owner_name_masked TEXT,
  lng               DOUBLE PRECISION,
  lat               DOUBLE PRECISION,
  sigir_count       INTEGER,
  manda_count       INTEGER,
  koyun_count       INTEGER,
  keci_count        INTEGER,
  dominant_species  TEXT,
  herd_species      TEXT[],
  visit_status      TEXT,
  neighbourhood_id  INTEGER,
  neighbourhood_name TEXT,
  herd_number       SMALLINT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_district_id INTEGER;
BEGIN
  SELECT district_id INTO v_district_id
  FROM campaigns WHERE id = p_campaign_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kampanya bulunamadı: %', p_campaign_id;
  END IF;

  RETURN QUERY
  SELECT
    h.id                            AS herd_id,
    h.enterprise_id::TEXT           AS enterprise_id,
    e.owner_name_masked::TEXT       AS owner_name_masked,
    ST_X(h.location::geometry)::DOUBLE PRECISION AS lng,
    ST_Y(h.location::geometry)::DOUBLE PRECISION AS lat,
    e.sigir_count::INTEGER          AS sigir_count,
    e.manda_count::INTEGER          AS manda_count,
    e.koyun_count::INTEGER          AS koyun_count,
    e.keci_count::INTEGER           AS keci_count,
    e.dominant_species::TEXT        AS dominant_species,
    h.species::TEXT[]               AS herd_species,
    COALESCE(latest_vl.status::TEXT, 'pending'::TEXT) AS visit_status,
    n.id::INTEGER                   AS neighbourhood_id,
    n.name::TEXT                    AS neighbourhood_name,
    h.herd_number::SMALLINT         AS herd_number
  FROM herds h
  JOIN enterprises e ON e.id = h.enterprise_id
  LEFT JOIN neighbourhoods n ON n.id = e.neighbourhood_id
  LEFT JOIN LATERAL (
    SELECT status FROM visit_logs
    WHERE visit_logs.herd_id = h.id AND visit_logs.campaign_id = p_campaign_id
    ORDER BY visit_logs.created_at DESC LIMIT 1
  ) latest_vl ON TRUE
  WHERE
    h.district_id = v_district_id
    AND h.is_active = TRUE
    AND e.is_active = TRUE
    AND h.location IS NOT NULL
    -- KESİN KONTROL: Sürünün türü (h.species), aranan türlerle(p_species) KESİŞMELİDİR. (&& operatörü kesişim arar)
    -- VEYA p_species boşsa hepsini getir.
    AND (
      p_species IS NULL 
      OR ARRAY_LENGTH(p_species, 1) = 0 
      OR h.species && p_species
    );
END;
$$;
