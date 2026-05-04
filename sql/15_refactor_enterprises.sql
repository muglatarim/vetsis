-- =====================================================================
-- VETSİS — Veri Temizleme + Şema + Fonksiyon Refactoru
-- Dosya: 15_refactor_enterprises.sql
-- Supabase SQL Editor'da çalıştırın.
-- =====================================================================

-- ============================================================
-- ADIM 1: Tabloları Temizle (CASCADE sırasıyla)
-- ============================================================
TRUNCATE TABLE public.daily_logs       CASCADE;
TRUNCATE TABLE public.daily_missions   CASCADE;
TRUNCATE TABLE public.visit_logs       CASCADE;
TRUNCATE TABLE public.temp_enterprises CASCADE;
TRUNCATE TABLE public.herds            CASCADE;
TRUNCATE TABLE public.enterprises      CASCADE;

-- ============================================================
-- ADIM 2: KVKK Alanlarını Kaldır
-- (owner_name, father_name = gerçek veriler artık tutulmayacak)
-- (vkn_hash, vkn_masked = TC ile birleştirildi, VKN ayrı gerek yok)
-- ============================================================
ALTER TABLE public.enterprises
  DROP COLUMN IF EXISTS owner_name,
  DROP COLUMN IF EXISTS father_name,
  DROP COLUMN IF EXISTS vkn_hash,
  DROP COLUMN IF EXISTS vkn_masked;

-- ============================================================
-- ADIM 3: Yeni Alan Ekle: owner_surname_masked
-- ============================================================
ALTER TABLE public.enterprises
  ADD COLUMN IF NOT EXISTS owner_surname_masked TEXT;

-- ============================================================
-- ADIM 4: upsert_enterprise_from_excel Güncelleme
-- Yeni parametreler: p_owner_surname_masked
-- Kaldırılan parametreler: p_owner_name, p_father_name, p_vkn_hash, p_vkn_masked  
-- TC/VKN tek sütunda: p_tc_hash ve p_tc_masked
-- NOT: PostgreSQL'de fonksiyon parametreleri değişince OVERLOAD (yeni fonksiyon) oluşur.
-- Bu yüzden eski fonksiyonu açıkça SİLMEMİZ gerekiyor.
-- ============================================================
DROP FUNCTION IF EXISTS public.upsert_enterprise_from_excel(TEXT, INTEGER, TEXT, INTEGER, INTEGER, INTEGER, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.upsert_enterprise_from_excel(TEXT, INTEGER, TEXT, INTEGER, INTEGER, INTEGER, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.upsert_enterprise_from_excel(
  p_enterprise_id       TEXT,
  p_district_id         INTEGER,
  p_neighbourhood       TEXT     DEFAULT NULL,
  p_sigir               INTEGER  DEFAULT NULL,  -- NULL = değiştirme
  p_manda               INTEGER  DEFAULT NULL,
  p_koyun               INTEGER  DEFAULT NULL,
  p_keci                INTEGER  DEFAULT NULL,
  p_owner_masked        TEXT     DEFAULT NULL,  -- Ad (maskeli)
  p_owner_surname_masked TEXT    DEFAULT NULL,  -- Soyad (maskeli)
  p_father_masked       TEXT     DEFAULT NULL,  -- Baba adı (maskeli)
  p_tc_hash             TEXT     DEFAULT NULL,  -- TC veya VKN hash
  p_tc_masked           TEXT     DEFAULT NULL,  -- TC veya VKN maskeli
  p_phone               TEXT     DEFAULT NULL,
  p_extra_data          JSONB    DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_neighbourhood_id INTEGER;
BEGIN
  -- Yetki kontrolü
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Kimlik doğrulama gerekli';
  END IF;
  IF public.get_my_role() = 'field_staff' THEN
    RAISE EXCEPTION 'Saha personelinin Excel yükleme yetkisi yok';
  END IF;
  IF public.get_my_role() = 'district_admin'
     AND public.get_my_district_id() != p_district_id THEN
    RAISE EXCEPTION 'Başka ilçenin verilerini güncelleme yetkiniz yok!';
  END IF;

  -- Mahalle ID bul
  IF p_neighbourhood IS NOT NULL AND TRIM(p_neighbourhood) != '' THEN
    SELECT id INTO v_neighbourhood_id
    FROM neighbourhoods
    WHERE district_id = p_district_id
      AND UPPER(TRIM(name)) = UPPER(TRIM(p_neighbourhood))
    LIMIT 1;
  END IF;

  -- Upsert
  INSERT INTO enterprises (
    id, district_id, neighbourhood_id,
    sigir_count, manda_count, koyun_count, keci_count,
    owner_name_masked, owner_surname_masked, father_name_masked,
    tc_hash, tc_masked, phone, extra_data
  )
  VALUES (
    p_enterprise_id, p_district_id, v_neighbourhood_id,
    COALESCE(p_sigir, 0), COALESCE(p_manda, 0), COALESCE(p_koyun, 0), COALESCE(p_keci, 0),
    p_owner_masked, p_owner_surname_masked, p_father_masked,
    p_tc_hash, p_tc_masked, p_phone, p_extra_data
  )
  ON CONFLICT (id) DO UPDATE SET
    district_id            = EXCLUDED.district_id,
    neighbourhood_id       = COALESCE(EXCLUDED.neighbourhood_id, enterprises.neighbourhood_id),
    -- Hayvan sayıları: NULL geldiyse mevcut değeri koru
    sigir_count            = CASE WHEN p_sigir IS NOT NULL THEN EXCLUDED.sigir_count ELSE enterprises.sigir_count END,
    manda_count            = CASE WHEN p_manda IS NOT NULL THEN EXCLUDED.manda_count ELSE enterprises.manda_count END,
    koyun_count            = CASE WHEN p_koyun IS NOT NULL THEN EXCLUDED.koyun_count ELSE enterprises.koyun_count END,
    keci_count             = CASE WHEN p_keci  IS NOT NULL THEN EXCLUDED.keci_count  ELSE enterprises.keci_count  END,
    -- Kişisel veriler: sadece yeni veri gelirse güncelle
    owner_name_masked      = COALESCE(EXCLUDED.owner_name_masked,      enterprises.owner_name_masked),
    owner_surname_masked   = COALESCE(EXCLUDED.owner_surname_masked,   enterprises.owner_surname_masked),
    father_name_masked     = COALESCE(EXCLUDED.father_name_masked,     enterprises.father_name_masked),
    tc_hash                = COALESCE(EXCLUDED.tc_hash,                enterprises.tc_hash),
    tc_masked              = COALESCE(EXCLUDED.tc_masked,              enterprises.tc_masked),
    phone                  = COALESCE(EXCLUDED.phone,                  enterprises.phone),
    extra_data             = COALESCE(EXCLUDED.extra_data,             enterprises.extra_data);

  RETURN p_enterprise_id;
END;
$$;

-- ============================================================
-- ADIM 5: reset_neighbourhood_animal_counts
-- Sadece excelde gelen mahalleleri sıfırlar (ilçe geneli değil!)
-- p_neighbourhood_names: Excel'deki mahalle isimlerinin listesi
-- ============================================================
CREATE OR REPLACE FUNCTION public.reset_neighbourhood_animal_counts(
  p_district_id         INTEGER,
  p_neighbourhood_names TEXT[]
)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_affected INTEGER;
  v_neighbourhood_ids INTEGER[];
BEGIN
  -- Yetki kontrolü
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Kimlik doğrulama gerekli';
  END IF;
  IF public.get_my_role() = 'field_staff' THEN
    RAISE EXCEPTION 'Saha personelinin Excel yükleme yetkisi yok';
  END IF;
  IF public.get_my_role() = 'district_admin'
     AND public.get_my_district_id() != p_district_id THEN
    RAISE EXCEPTION 'Başka ilçenin verilerini sıfırlama yetkiniz yok!';
  END IF;

  -- İlçe + mahalle adlarından ID listesi çıkar (büyük/küçük harf bağımsız)
  SELECT ARRAY_AGG(id) INTO v_neighbourhood_ids
  FROM neighbourhoods
  WHERE district_id = p_district_id
    AND UPPER(TRIM(name)) = ANY(
      SELECT UPPER(TRIM(unnest)) FROM UNNEST(p_neighbourhood_names) AS unnest
    );

  -- Sadece bu mahallelerdeki işletmeleri sıfırla
  UPDATE enterprises
  SET
    sigir_count = 0,
    manda_count = 0,
    koyun_count = 0,
    keci_count  = 0
  WHERE district_id = p_district_id
    AND neighbourhood_id = ANY(v_neighbourhood_ids);

  GET DIAGNOSTICS v_affected = ROW_COUNT;

  RAISE LOG 'VETSİS AUDIT: İlçe=%, % mahalle, % işletme hayvan sayısı sıfırlandı. Kullanıcı: %',
    p_district_id, ARRAY_LENGTH(v_neighbourhood_ids, 1), v_affected, auth.uid();

  RETURN v_affected;
END;
$$;

-- ============================================================
-- ADIM 6: get_campaign_herds — Yeni alanlar eklendi
-- owner_surname_masked, father_name_masked, tc_masked, phone
-- NOT: Dönüş tipi değiştiği için DROP zorunludur.
-- ============================================================
DROP FUNCTION IF EXISTS public.get_campaign_herds(UUID, TEXT[]);

CREATE OR REPLACE FUNCTION public.get_campaign_herds(
  p_campaign_id UUID,
  p_species     TEXT[]
)
RETURNS TABLE (
  herd_id               UUID,
  enterprise_id         TEXT,
  owner_name_masked     TEXT,
  owner_surname_masked  TEXT,
  father_name_masked    TEXT,
  tc_masked             TEXT,
  phone                 TEXT,
  lng                   DOUBLE PRECISION,
  lat                   DOUBLE PRECISION,
  sigir_count           INTEGER,
  manda_count           INTEGER,
  koyun_count           INTEGER,
  keci_count            INTEGER,
  dominant_species      TEXT,
  herd_species          TEXT[],
  visit_status          TEXT,
  neighbourhood_id      INTEGER,
  neighbourhood_name    TEXT,
  herd_number           SMALLINT
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
    h.id                                            AS herd_id,
    h.enterprise_id::TEXT                           AS enterprise_id,
    e.owner_name_masked::TEXT                       AS owner_name_masked,
    e.owner_surname_masked::TEXT                    AS owner_surname_masked,
    e.father_name_masked::TEXT                      AS father_name_masked,
    e.tc_masked::TEXT                               AS tc_masked,
    e.phone::TEXT                                   AS phone,
    ST_X(h.location::geometry)::DOUBLE PRECISION    AS lng,
    ST_Y(h.location::geometry)::DOUBLE PRECISION    AS lat,
    e.sigir_count::INTEGER                          AS sigir_count,
    e.manda_count::INTEGER                          AS manda_count,
    e.koyun_count::INTEGER                          AS koyun_count,
    e.keci_count::INTEGER                           AS keci_count,
    e.dominant_species::TEXT                        AS dominant_species,
    h.species::TEXT[]                               AS herd_species,
    COALESCE(latest_vl.status::TEXT, 'pending'::TEXT) AS visit_status,
    n.id::INTEGER                                   AS neighbourhood_id,
    n.name::TEXT                                    AS neighbourhood_name,
    h.herd_number::SMALLINT                         AS herd_number
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
    AND (e.sigir_count + e.manda_count + e.koyun_count + e.keci_count) > 0
    AND (
      p_species IS NULL OR ARRAY_LENGTH(p_species, 1) = 0 OR
      ('sigir' = ANY(p_species) AND e.sigir_count > 0) OR
      ('manda' = ANY(p_species) AND e.manda_count > 0) OR
      ('koyun' = ANY(p_species) AND e.koyun_count > 0) OR
      ('keci'  = ANY(p_species) AND e.keci_count  > 0)
    );
END;
$$;
