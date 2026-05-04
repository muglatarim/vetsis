-- =====================================================================
-- VETSİS — 0 Hayvanı Olan İşletmelerin Haritada Çıkmasını Düzeltme
-- Dosya: 14_fix_zero_count_bug.sql
-- =====================================================================

-- Önceki (13 nolu) yama "sürünün kendisi koyun olsa bile gözükecek" mantığını
-- kurarken ('sigir' = ANY(h.species)) kuralını da eklemişti.
-- Fakat bu durum, eskiden sürüsü "sığır" olarak açılmış ama güncel sığır sayısı 0'a
-- düşmüş (sadece koyunu olan) işletmelerin de sığır kampanyalarında çıkmasına yol açtı.
--
-- Bu güncellemeyle; bir işletmenin SADECE ve KESİNLİKLE o hayvandan (sayısal olarak)
-- > 0 adet barındırıyorsa çalışması sağlandı. 
-- Kural hala geçerli: İşletmenin inek sayısı > 0 ise, o işletmenin tüm noktaları haritada çıkar.

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
    
    -- Toplam hayvan > 0 (sıfır sayılılar kesinlikle haritada görünmez)
    AND (e.sigir_count + e.manda_count + e.koyun_count + e.keci_count) > 0

    -- YENİ VE KESİN KURAL: Seçili kampanyadaki türler için, 
    -- o hayvanın işletmedeki güncel SAYISININ 0'dan büyük olması zorunludur!
    AND (
      p_species IS NULL OR ARRAY_LENGTH(p_species, 1) = 0 OR
      ('sigir' = ANY(p_species) AND e.sigir_count > 0) OR
      ('manda' = ANY(p_species) AND e.manda_count > 0) OR
      ('koyun' = ANY(p_species) AND e.koyun_count > 0) OR
      ('keci'  = ANY(p_species) AND e.keci_count  > 0)
    );
END;
$$;
