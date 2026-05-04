-- =====================================================================
-- VETSİS — İş Mantığı Fonksiyonları
-- Dosya: 03_functions.sql
-- NOT: 01_schema.sql ve 02_rls_policies.sql çalıştırıldıktan sonra.
-- =====================================================================

-- ============================================================
-- 1. İLÇE HAYVAN SAYISI SIFIRLAMA (Excel İzolasyonu - GÜVENLİ)
-- Sadece belirtilen ilçenin işletme hayvan sayılarını sıfırlar.
-- Diğer ilçelerin verilerine KESINLIKLE dokunmaz.
-- Dönüş: Etkilenen işletme sayısı
-- ============================================================
CREATE OR REPLACE FUNCTION public.reset_district_animal_counts(
  p_district_id INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_affected INTEGER;
BEGIN
  -- Kimlik doğrulama zorunlu
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Kimlik doğrulama gerekli';
  END IF;

  -- Saha personeli yükleyemez
  IF public.get_my_role() = 'field_staff' THEN
    RAISE EXCEPTION 'Saha personelinin Excel yükleme yetkisi yok';
  END IF;

  -- İlçe yöneticisi sadece kendi ilçesini sıfırlayabilir
  IF public.get_my_role() = 'district_admin'
     AND public.get_my_district_id() != p_district_id THEN
    RAISE EXCEPTION 'Başka ilçenin verilerini sıfırlama yetkiniz yok!';
  END IF;

  -- YALNIZCA bu ilçenin hayvan sayılarını sıfırla
  UPDATE enterprises
  SET
    sigir_count = 0,
    manda_count = 0,
    koyun_count = 0,
    keci_count  = 0
  WHERE district_id = p_district_id;

  GET DIAGNOSTICS v_affected = ROW_COUNT;

  RAISE LOG 'VETSİS AUDIT: İlçe=% için % işletme sıfırlandı. Kullanıcı: %',
    p_district_id, v_affected, auth.uid();

  RETURN v_affected;
END;
$$;

-- ============================================================
-- 2. TOPLU İŞLETME UPSERT (İşletmeListesi.xls Yükleme)
-- Excel satırı → işletme kaydı oluştur veya güncelle.
-- ============================================================
CREATE OR REPLACE FUNCTION public.upsert_enterprise_from_excel(
  p_enterprise_id  TEXT,    -- Örn: TR4800000123
  p_district_id    INTEGER,
  p_neighbourhood  TEXT     DEFAULT NULL,
  p_sigir          INTEGER  DEFAULT 0,
  p_manda          INTEGER  DEFAULT 0,
  p_koyun          INTEGER  DEFAULT 0,
  p_keci           INTEGER  DEFAULT 0,
  p_owner_masked   TEXT     DEFAULT NULL,
  p_father_masked  TEXT     DEFAULT NULL,
  p_tc_hash        TEXT     DEFAULT NULL,
  p_tc_masked      TEXT     DEFAULT NULL,
  p_vkn_hash       TEXT     DEFAULT NULL,
  p_vkn_masked     TEXT     DEFAULT NULL,
  p_phone          TEXT     DEFAULT NULL,
  p_extra_data     JSONB    DEFAULT NULL
)
RETURNS TEXT   -- enterprise_id döndürür
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_neighbourhood_id INTEGER;
BEGIN
  -- Mahalle ID'sini bul (büyük/küçük harf bağımsız)
  IF p_neighbourhood IS NOT NULL AND p_neighbourhood != '' THEN
    SELECT id INTO v_neighbourhood_id
    FROM neighbourhoods
    WHERE district_id = p_district_id
      AND UPPER(TRIM(name)) = UPPER(TRIM(p_neighbourhood))
    LIMIT 1;
  END IF;

  -- Upsert: Varsa güncelle, yoksa ekle
  INSERT INTO enterprises (
    id, district_id, neighbourhood_id,
    sigir_count, manda_count, koyun_count, keci_count,
    owner_name_masked, father_name_masked,
    tc_hash, tc_masked, vkn_hash, vkn_masked, phone,
    extra_data
  )
  VALUES (
    p_enterprise_id, p_district_id, v_neighbourhood_id,
    p_sigir, p_manda, p_koyun, p_keci,
    p_owner_masked, p_father_masked,
    p_tc_hash, p_tc_masked, p_vkn_hash, p_vkn_masked, p_phone,
    p_extra_data
  )
  ON CONFLICT (id) DO UPDATE SET
    district_id      = EXCLUDED.district_id,
    neighbourhood_id = COALESCE(EXCLUDED.neighbourhood_id, enterprises.neighbourhood_id),
    sigir_count      = EXCLUDED.sigir_count,
    manda_count      = EXCLUDED.manda_count,
    koyun_count      = EXCLUDED.koyun_count,
    keci_count       = EXCLUDED.keci_count,
    owner_name_masked  = COALESCE(EXCLUDED.owner_name_masked, enterprises.owner_name_masked),
    father_name_masked = COALESCE(EXCLUDED.father_name_masked, enterprises.father_name_masked),
    tc_hash          = COALESCE(EXCLUDED.tc_hash, enterprises.tc_hash),
    tc_masked        = COALESCE(EXCLUDED.tc_masked, enterprises.tc_masked),
    vkn_hash         = COALESCE(EXCLUDED.vkn_hash, enterprises.vkn_hash),
    vkn_masked       = COALESCE(EXCLUDED.vkn_masked, enterprises.vkn_masked),
    phone            = COALESCE(EXCLUDED.phone, enterprises.phone),
    extra_data       = COALESCE(EXCLUDED.extra_data, enterprises.extra_data);

  RETURN p_enterprise_id;
END;
$$;

-- ============================================================
-- 3. KAMPANYA SÜRÜ HARİTASI (Tür Filtreli PostGIS Sorgusu)
-- Sadece seçili türlere sahip, konumu girilmiş sürüleri döndürür.
-- Hayvan sayısı 0 olan işletmeler haritada GÖSTERİLMEZ.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_campaign_herds(
  p_campaign_id UUID,
  p_species     TEXT[]   -- Örn: ARRAY['sigir','koyun']
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
    h.enterprise_id,
    e.owner_name_masked,
    ST_X(h.location::geometry)      AS lng,
    ST_Y(h.location::geometry)      AS lat,
    e.sigir_count,
    e.manda_count,
    e.koyun_count,
    e.keci_count,
    e.dominant_species::TEXT,
    h.species::TEXT[],
    -- En son ziyaret durumu (LATERAL join)
    COALESCE(latest_vl.status, 'pending') AS visit_status,
    n.id                            AS neighbourhood_id,
    n.name                          AS neighbourhood_name,
    h.herd_number

  FROM herds h
  JOIN enterprises e ON e.id = h.enterprise_id
  LEFT JOIN neighbourhoods n ON n.id = e.neighbourhood_id

  -- En son visit_log'u çek (DISTINCT ON yerine LATERAL daha verimli)
  LEFT JOIN LATERAL (
    SELECT status
    FROM visit_logs
    WHERE herd_id = h.id AND campaign_id = p_campaign_id
    ORDER BY created_at DESC
    LIMIT 1
  ) latest_vl ON TRUE

  WHERE
    h.district_id = v_district_id
    AND h.is_active = TRUE
    AND e.is_active = TRUE
    AND h.location IS NOT NULL
    -- Toplam hayvan > 0 (sıfır sayılılar haritada görünmez)
    AND (e.sigir_count + e.manda_count + e.koyun_count + e.keci_count) > 0
    -- Tür filtresi: En az bir türe sahipse göster
    AND (
      ('sigir' = ANY(p_species) AND e.sigir_count > 0) OR
      ('manda' = ANY(p_species) AND e.manda_count > 0) OR
      ('koyun' = ANY(p_species) AND e.koyun_count > 0) OR
      ('keci'  = ANY(p_species) AND e.keci_count  > 0)
    );
END;
$$;

-- ============================================================
-- 4. YAKIN SÜRÜ TESPİTİ (GPS 20m Otomatik Sarı Pin)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_nearby_herds(
  p_campaign_id UUID,
  p_lat         DOUBLE PRECISION,
  p_lng         DOUBLE PRECISION,
  p_radius_m    DOUBLE PRECISION DEFAULT 20.0
)
RETURNS TABLE (
  herd_id       UUID,
  enterprise_id TEXT,
  distance_m    DOUBLE PRECISION,
  visit_status  TEXT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_district_id INTEGER;
  v_user_geog   GEOGRAPHY;
BEGIN
  SELECT district_id INTO v_district_id FROM campaigns WHERE id = p_campaign_id;

  v_user_geog := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;

  RETURN QUERY
  SELECT
    h.id,
    h.enterprise_id,
    ST_Distance(h.location::geography, v_user_geog)::DOUBLE PRECISION,
    COALESCE(latest_vl.status, 'pending')
  FROM herds h
  LEFT JOIN LATERAL (
    SELECT status
    FROM visit_logs
    WHERE herd_id = h.id AND campaign_id = p_campaign_id
    ORDER BY created_at DESC
    LIMIT 1
  ) latest_vl ON TRUE
  WHERE
    h.district_id = v_district_id
    AND h.is_active = TRUE
    AND h.location IS NOT NULL
    AND ST_DWithin(h.location::geography, v_user_geog, p_radius_m)
  ORDER BY ST_Distance(h.location::geography, v_user_geog);
END;
$$;

-- ============================================================
-- 5. TC HASH İLE İŞLETME ARAMA
-- Aktif, pasif, iptal → is_active filtresi olmadan tüm kayıtlar
-- ============================================================
CREATE OR REPLACE FUNCTION public.find_enterprises_by_tc(
  p_tc_hash TEXT
)
RETURNS TABLE (
  enterprise_id     TEXT,
  owner_name_masked TEXT,
  father_name_masked TEXT,
  tc_masked         TEXT,
  district_name     TEXT,
  province_name     TEXT,
  is_active         BOOLEAN,
  sigir_count       INTEGER,
  manda_count       INTEGER,
  koyun_count       INTEGER,
  keci_count        INTEGER
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Güvenlik: sadece yetkililer çağırabilir
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Kimlik doğrulama gerekli';
  END IF;

  RETURN QUERY
  SELECT
    e.id,
    e.owner_name_masked,
    e.father_name_masked,
    e.tc_masked,
    d.name,
    p.name,
    e.is_active,
    e.sigir_count,
    e.manda_count,
    e.koyun_count,
    e.keci_count
  FROM enterprises e
  JOIN districts d ON d.id = e.district_id
  JOIN provinces p ON p.id = d.province_id
  WHERE e.tc_hash = p_tc_hash
  ORDER BY e.is_active DESC, e.created_at DESC;
END;
$$;

-- ============================================================
-- 6. GEÇİCİ → GERÇEK İŞLETME BİRLEŞTİRME
-- ON UPDATE CASCADE: herds.enterprise_id otomatik güncellenir
-- ============================================================
CREATE OR REPLACE FUNCTION public.merge_temp_to_real_enterprise(
  p_temp_id     TEXT,
  p_real_id     TEXT,
  p_district_id INTEGER
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Gerçek işletmeyi oluştur (yoksa)
  INSERT INTO enterprises (id, district_id)
  VALUES (p_real_id, p_district_id)
  ON CONFLICT (id) DO NOTHING;

  -- Geçici ID'yi gerçek ID ile değiştir
  -- herds.enterprise_id ON UPDATE CASCADE sayesinde otomatik güncellenir!
  UPDATE enterprises SET id = p_real_id WHERE id = p_temp_id;

  -- Temp kaydını güncelle
  UPDATE temp_enterprises
  SET real_id = p_real_id, merged_at = NOW()
  WHERE temp_id = p_temp_id;

  RAISE LOG 'VETSİS: Temp % → Gerçek % birleştirme tamamlandı. Kullanıcı: %',
    p_temp_id, p_real_id, auth.uid();
END;
$$;

-- ============================================================
-- 7. GÜNLÜK ÖZET (Görevi Bitir ekranı için)
-- Kullanıcının aşı sayısı girerken göreceği istatistikler
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_daily_summary(
  p_campaign_id  UUID,
  p_user_id      UUID,
  p_date         DATE
)
RETURNS TABLE (
  visited_enterprise_count INTEGER,
  total_animals_count      INTEGER
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(DISTINCT e.id)::INTEGER AS visited_enterprise_count,
    COALESCE(SUM(e.sigir_count + e.manda_count + e.koyun_count + e.keci_count), 0)::INTEGER AS total_animals_count
  FROM visit_logs vl
  JOIN herds h ON h.id = vl.herd_id
  JOIN enterprises e ON e.id = h.enterprise_id
  WHERE
    vl.campaign_id = p_campaign_id
    AND vl.user_id = p_user_id
    AND vl.operation_date = p_date
    AND vl.status = 'visited';
END;
$$;

-- ============================================================
-- 8. MAHALLE TAMAMLANMA YÜZDESİ (İlerleme çubuğu)
-- Sadece 'visited' (yeşil tik) sürüler sayılır
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_neighbourhood_completion(
  p_campaign_id      UUID,
  p_neighbourhood_id INTEGER
)
RETURNS TABLE (
  neighbourhood_id   INTEGER,
  total_herds        INTEGER,
  visited_herds      INTEGER,
  completion_pct     NUMERIC(5,1)
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  SELECT
    p_neighbourhood_id,
    COUNT(h.id)::INTEGER,
    COUNT(CASE WHEN latest_vl.status = 'visited' THEN 1 END)::INTEGER,
    CASE
      WHEN COUNT(h.id) = 0 THEN 0.0
      ELSE ROUND(
        100.0 * COUNT(CASE WHEN latest_vl.status = 'visited' THEN 1 END)
        / COUNT(h.id),
      1)
    END
  FROM herds h
  JOIN enterprises e ON e.id = h.enterprise_id
  LEFT JOIN LATERAL (
    SELECT status
    FROM visit_logs
    WHERE herd_id = h.id AND campaign_id = p_campaign_id
    ORDER BY created_at DESC LIMIT 1
  ) latest_vl ON TRUE
  WHERE
    h.is_active = TRUE
    AND e.is_active = TRUE
    AND e.neighbourhood_id = p_neighbourhood_id
    AND (e.sigir_count + e.manda_count + e.koyun_count + e.keci_count) > 0;
END;
$$;

-- ============================================================
-- 9. KAMPANYA İSTATİSTİKLERİ (Genel özet)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_campaign_stats(p_campaign_id UUID)
RETURNS TABLE (
  total_herds    BIGINT,
  pending_herds  BIGINT,
  detected_herds BIGINT,
  visited_herds  BIGINT,
  pct_completed  NUMERIC(5,1)
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_district_id INTEGER;
BEGIN
  SELECT district_id INTO v_district_id FROM campaigns WHERE id = p_campaign_id;

  RETURN QUERY
  WITH herd_statuses AS (
    SELECT
      h.id AS herd_id,
      COALESCE(latest_vl.status, 'pending') AS status
    FROM herds h
    JOIN enterprises e ON e.id = h.enterprise_id
    LEFT JOIN LATERAL (
      SELECT status FROM visit_logs
      WHERE herd_id = h.id AND campaign_id = p_campaign_id
      ORDER BY created_at DESC LIMIT 1
    ) latest_vl ON TRUE
    WHERE h.district_id = v_district_id
      AND h.is_active = TRUE
      AND e.is_active = TRUE
      AND (e.sigir_count + e.manda_count + e.koyun_count + e.keci_count) > 0
  )
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE status = 'pending'),
    COUNT(*) FILTER (WHERE status = 'detected'),
    COUNT(*) FILTER (WHERE status = 'visited'),
    CASE WHEN COUNT(*) = 0 THEN 0.0
    ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'visited') / COUNT(*), 1)
    END
  FROM herd_statuses;
END;
$$;
