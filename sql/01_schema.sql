-- =====================================================================
-- VETSİS — Veteriner Saha Kampanya Yönetim Sistemi
-- Dosya: 01_schema.sql
-- Açıklama: Tablolar, Trigger'lar, İndeksler
-- PostgreSQL 15 / Supabase
-- =====================================================================

-- ============================================================
-- 1. UZANTILAR
-- ============================================================
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- 2. ENUM TİPLERİ (Yeniden çalıştırmaya karşı güvenli)
-- ============================================================
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM (
    'super_admin',    -- Sistem yöneticisi
    'province_admin', -- İl yöneticisi
    'district_admin', -- İlçe yöneticisi
    'field_staff'     -- Saha personeli
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE animal_species AS ENUM (
    'sigir',  -- Sığır
    'manda',  -- Manda
    'koyun',  -- Koyun
    'keci'    -- Keçi
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE herd_visit_status AS ENUM (
    'pending',   -- Mavi/Gri pin — henüz gidilmedi
    'detected',  -- Sarı/Turuncu pin — GPS ile 20m tespit edildi
    'visited'    -- Yeşil pin + Tik — onaylandı
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE campaign_status AS ENUM (
    'active',
    'completed',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- 3. İLLER (Provinces) — tum_turkiye.csv'den seed edilir
-- ============================================================
CREATE TABLE IF NOT EXISTS provinces (
  id         SMALLINT PRIMARY KEY,  -- Türkiye plaka kodu (01–81)
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 4. İLÇELER (Districts)
-- ============================================================
CREATE TABLE IF NOT EXISTS districts (
  id          SERIAL PRIMARY KEY,
  province_id SMALLINT NOT NULL REFERENCES provinces(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(province_id, name)
);

CREATE INDEX IF NOT EXISTS idx_districts_province ON districts(province_id);

-- ============================================================
-- 5. MAHALLELER (Neighbourhoods)
-- NOT: Polygon geometrisi Supabase'de değil, maps/ klasöründeki
-- GeoJSON dosyalarında tutulur. Sadece metadata saklanır.
-- geojson_feature_id → maps/IL.geojson içindeki feature.id
-- ============================================================
CREATE TABLE IF NOT EXISTS neighbourhoods (
  id                 SERIAL PRIMARY KEY,
  district_id        INTEGER NOT NULL REFERENCES districts(id) ON DELETE RESTRICT,
  name               TEXT NOT NULL,         -- CSV'deki sistem mahalle adı
  geojson_feature_id INTEGER,               -- GeoJSON'daki feature index/id
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(district_id, name)
);

CREATE INDEX IF NOT EXISTS idx_neighbourhoods_district ON neighbourhoods(district_id);

-- ============================================================
-- 6. KULLANICI PROFİLLERİ (Supabase auth.users'a bağlı)
-- ============================================================
CREATE TABLE IF NOT EXISTS profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name   TEXT,
  email       TEXT NOT NULL,
  role        user_role NOT NULL DEFAULT 'field_staff',
  province_id SMALLINT REFERENCES provinces(id) ON DELETE SET NULL,
  district_id INTEGER  REFERENCES districts(id) ON DELETE SET NULL,
  avatar_url  TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profiles_province    ON profiles(province_id);
CREATE INDEX IF NOT EXISTS idx_profiles_district    ON profiles(district_id);
CREATE INDEX IF NOT EXISTS idx_profiles_role        ON profiles(role);

-- ============================================================
-- Ortak updated_at trigger fonksiyonu
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ============================================================
-- Auth'dan otomatik profil oluşturma (Google Sign-In sonrası)
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Profiles updated_at trigger
DROP TRIGGER IF EXISTS trg_profiles_updated_at ON profiles;
CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- 7. İŞLETMELER (Enterprises)
-- NOT: Hayvan sayıları işletme ID'sine göre eşleştirildiğinden
-- enterprise tablosunda tutulur (herds'te değil).
-- ============================================================
CREATE TABLE IF NOT EXISTS enterprises (
  id               TEXT PRIMARY KEY,         -- TR4800000123 formatı

  district_id      INTEGER NOT NULL REFERENCES districts(id) ON DELETE RESTRICT,
  neighbourhood_id INTEGER REFERENCES neighbourhoods(id) ON DELETE SET NULL,

  -- ---- Kişisel Veriler (KVKK) -----------------------------------
  -- Gerçek değerler yalnızca 'province_admin' ve 'super_admin' görebilir
  owner_name         TEXT,          -- Gerçek ad soyad
  owner_name_masked  TEXT,          -- "İ*** Y***" — herkes görebilir
  father_name        TEXT,          -- Gerçek baba adı
  father_name_masked TEXT,          -- "M***" — herkes görebilir
  tc_hash            TEXT,          -- SHA-256(SALT||TC) — arama/eşleştirme
  tc_masked          TEXT,          -- "1*****1" — görüntüleme
  vkn_hash           TEXT,          -- SHA-256(SALT||VKN)
  vkn_masked         TEXT,          -- "12****89"
  phone              TEXT,

  -- ---- Hayvan Sayıları (İşletmeListesi.xls → Upsert) ------------
  sigir_count    INTEGER NOT NULL DEFAULT 0 CHECK (sigir_count >= 0),
  manda_count    INTEGER NOT NULL DEFAULT 0 CHECK (manda_count >= 0),
  koyun_count    INTEGER NOT NULL DEFAULT 0 CHECK (koyun_count >= 0),
  keci_count     INTEGER NOT NULL DEFAULT 0 CHECK (keci_count >= 0),
  dominant_species animal_species,  -- Otomatik hesaplanır (trigger aşağıda)

  -- ---- Extra & Durum --------------------------------------------
  extra_data JSONB,    -- Excel'deki dinamik/ek sütunlar
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_enterprises_district      ON enterprises(district_id);
CREATE INDEX IF NOT EXISTS idx_enterprises_neighbourhood ON enterprises(neighbourhood_id);
CREATE INDEX IF NOT EXISTS idx_enterprises_tc_hash       ON enterprises(tc_hash)
  WHERE tc_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_enterprises_active        ON enterprises(district_id, is_active)
  WHERE is_active = TRUE;

-- Baskın tür otomatik hesaplama trigger'ı
CREATE OR REPLACE FUNCTION public.calc_enterprise_dominant()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_max INTEGER;
BEGIN
  v_max := GREATEST(NEW.sigir_count, NEW.manda_count, NEW.koyun_count, NEW.keci_count);
  IF     v_max = 0                   THEN NEW.dominant_species := NULL;
  ELSIF  v_max = NEW.sigir_count     THEN NEW.dominant_species := 'sigir';
  ELSIF  v_max = NEW.manda_count     THEN NEW.dominant_species := 'manda';
  ELSIF  v_max = NEW.koyun_count     THEN NEW.dominant_species := 'koyun';
  ELSE                                    NEW.dominant_species := 'keci';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enterprise_dominant ON enterprises;
CREATE TRIGGER trg_enterprise_dominant
  BEFORE INSERT OR UPDATE OF sigir_count, manda_count, koyun_count, keci_count
  ON enterprises
  FOR EACH ROW EXECUTE FUNCTION public.calc_enterprise_dominant();

DROP TRIGGER IF EXISTS trg_enterprises_updated_at ON enterprises;
CREATE TRIGGER trg_enterprises_updated_at
  BEFORE UPDATE ON enterprises
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- 8. SÜRÜLER (Herds) — GPS konumu + (Sürü-2 için tür listesi)
-- Hayvan sayıları enterprises'ta. Herds sadece konum tutar.
-- Aynı işletmenin hayvanları farklı noktalardaysa Sürü-2 açılır.
-- ============================================================
CREATE TABLE IF NOT EXISTS herds (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id TEXT NOT NULL
    REFERENCES enterprises(id) ON UPDATE CASCADE ON DELETE CASCADE,
  herd_number   SMALLINT NOT NULL DEFAULT 1,  -- 1=Ana sürü, 2+=Ek sürü

  -- GPS koordinatı (NULL = konum henüz işaretlenmedi)
  location      GEOMETRY(Point, 4326),

  -- Sürü-2+ için hangi türler bu noktada (checkbox'tan)
  species       animal_species[],

  district_id   INTEGER NOT NULL REFERENCES districts(id),
  notes         TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(enterprise_id, herd_number)
);

CREATE INDEX IF NOT EXISTS idx_herds_location      ON herds USING GIST (location)
  WHERE location IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_herds_enterprise    ON herds(enterprise_id);
CREATE INDEX IF NOT EXISTS idx_herds_district      ON herds(district_id);

DROP TRIGGER IF EXISTS trg_herds_updated_at ON herds;
CREATE TRIGGER trg_herds_updated_at
  BEFORE UPDATE ON herds
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- 9. KAMPANYALAR (Campaigns)
-- İlçe Yöneticisi tarafından oluşturulur.
-- operation_date ilk çalışma günü kilitlenir.
-- ============================================================
CREATE TABLE IF NOT EXISTS campaigns (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id    INTEGER NOT NULL REFERENCES districts(id) ON DELETE RESTRICT,
  created_by     UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  name           TEXT NOT NULL,         -- Örn: "2026 İlkbahar Şap Aşısı"
  description    TEXT,
  status         campaign_status NOT NULL DEFAULT 'active',
  operation_date DATE,                  -- İlk çalışma tarihi (kilitlenir)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_district ON campaigns(district_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status   ON campaigns(status);

DROP TRIGGER IF EXISTS trg_campaigns_updated_at ON campaigns;
CREATE TRIGGER trg_campaigns_updated_at
  BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- 10. KAMPANYA HAYVaN TÜRLERİ
-- ============================================================
CREATE TABLE IF NOT EXISTS campaign_species (
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  species     animal_species NOT NULL,
  PRIMARY KEY (campaign_id, species)
);

-- ============================================================
-- 11. KAMPANYA PERSONELİ (e-posta ile davet)
-- ============================================================
CREATE TABLE IF NOT EXISTS campaign_staff (
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  invited_by  UUID NOT NULL REFERENCES profiles(id),
  invited_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (campaign_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_staff_user ON campaign_staff(user_id);

-- ============================================================
-- 12. ZİYARET LOGLARI (pending → detected → visited)
-- ============================================================
CREATE TABLE IF NOT EXISTS visit_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  herd_id        UUID NOT NULL REFERENCES herds(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES profiles(id),
  status         herd_visit_status NOT NULL DEFAULT 'pending',
  detected_at    TIMESTAMPTZ,   -- GPS 20m → sarı pin
  visited_at     TIMESTAMPTZ,   -- Kullanıcı onayı → yeşil pin
  operation_date DATE NOT NULL, -- Kilitli operasyon tarihi!
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_visit_logs_campaign ON visit_logs(campaign_id);
CREATE INDEX IF NOT EXISTS idx_visit_logs_herd     ON visit_logs(herd_id);
CREATE INDEX IF NOT EXISTS idx_visit_logs_user     ON visit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_visit_logs_status   ON visit_logs(status);
CREATE INDEX IF NOT EXISTS idx_visit_logs_date     ON visit_logs(operation_date);

-- ============================================================
-- 13. GÜNLÜK MESAİ LOGLARI (Aşı sayısı + İstatistikler)
-- ============================================================
CREATE TABLE IF NOT EXISTS daily_logs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id              UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id                  UUID NOT NULL REFERENCES profiles(id),
  operation_date           DATE NOT NULL,
  vaccine_count_applied    INTEGER NOT NULL DEFAULT 0 CHECK (vaccine_count_applied >= 0),
  visited_enterprise_count INTEGER NOT NULL DEFAULT 0,
  total_animals_visited    INTEGER NOT NULL DEFAULT 0,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(campaign_id, user_id, operation_date)
);

-- ============================================================
-- 14. GEÇİCİ İŞLETMELER (Sahada kayıtsız kişiler)
-- TC girilince find_enterprises_by_tc() ile aranır, merge edilir.
-- ON UPDATE CASCADE → herds ve visit_logs otomatik güncellenir.
-- ============================================================
CREATE TABLE IF NOT EXISTS temp_enterprises (
  temp_id        TEXT PRIMARY KEY,     -- TEMP-20260410-ABCDE
  real_id        TEXT REFERENCES enterprises(id) ON UPDATE CASCADE ON DELETE SET NULL,
  district_id    INTEGER NOT NULL REFERENCES districts(id),
  owner_name     TEXT,
  tc_search_hash TEXT,                 -- TC arama için hash (eşleşme öncesi)
  notes          TEXT,
  merged_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
