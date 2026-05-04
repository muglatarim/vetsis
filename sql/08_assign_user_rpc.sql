-- =====================================================================
-- VETSİS — Yöneticiler için Kullanıcı Davet / Transfer / Durum Fonksiyonları
-- =====================================================================

-- 1. E-posta ile pasif kullanıcıyı bulunduğunuz İl/İlçeye atama fonksiyonu (Davet)
CREATE OR REPLACE FUNCTION public.assign_passive_user_by_email(p_email TEXT, p_district_id INTEGER DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller_role user_role;
  v_caller_district INTEGER;
  v_caller_province SMALLINT;
  v_target_id UUID;
  v_target_is_active BOOLEAN;
  v_target_full_name TEXT;
  v_target_district_id INTEGER;
  v_target_province_id SMALLINT;
BEGIN
  -- Yetkileri ve bölgeyi al
  SELECT role, district_id, province_id INTO v_caller_role, v_caller_district, v_caller_province
  FROM public.profiles WHERE id = auth.uid();

  IF v_caller_role NOT IN ('super_admin', 'province_admin', 'district_admin') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Bu işlem için yetkiniz yok.');
  END IF;

  -- Hedef kullanıcıyı bul
  SELECT id, is_active, full_name INTO v_target_id, v_target_is_active, v_target_full_name
  FROM public.profiles
  WHERE lower(email) = lower(trim(p_email));

  IF v_target_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Bu e-posta adresine sahip bir kullanıcı bulunamadı.');
  END IF;

  IF v_target_is_active = TRUE THEN
    RETURN jsonb_build_object('success', false, 'message', 'Bu kullanıcı şu anda aktif. Lütfen önce hesabını pasife almasını isteyin.');
  END IF;

  -- İlçe Yöneticisi için kontroller
  IF v_caller_role = 'district_admin' THEN
    v_target_district_id := v_caller_district;
    v_target_province_id := v_caller_province;
  
  -- İl Yöneticisi için kontroller
  ELSIF v_caller_role = 'province_admin' THEN
    IF p_district_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'message', 'İl Yöneticisi olarak atama yapılacak ilçeyi seçmelisiniz.');
    END IF;

    -- Seçilen ilçenin İl yöneticisinin iline ait olduğunu doğrula
    IF NOT EXISTS (SELECT 1 FROM public.districts WHERE id = p_district_id AND province_id = v_caller_province) THEN
       RETURN jsonb_build_object('success', false, 'message', 'Seçilen ilçe sizin yetki alanınızda (ilinizde) değil.');
    END IF;
    
    v_target_district_id := p_district_id;
    v_target_province_id := v_caller_province;

  -- Super Admin için
  ELSE
     -- Süper admin isterse her yere atayabilir ancak UI şimdilik il/ilçe bazlı olacak
     v_target_district_id := p_district_id;
     IF p_district_id IS NOT NULL THEN
       SELECT province_id INTO v_target_province_id FROM public.districts WHERE id = p_district_id;
     END IF;
  END IF;

  -- Kullanıcıyı Cihazına/Kendi Bölgesine transfer et ve aktif yap
  UPDATE public.profiles
  SET is_active = TRUE, 
      district_id = v_target_district_id, 
      province_id = v_target_province_id,
      updated_at = NOW()
  WHERE id = v_target_id;

  RETURN jsonb_build_object('success', true, 'message', COALESCE(v_target_full_name, p_email) || ' başarıyla kadronuza eklendi.');
END;
$$;


-- 2. Yöneticilerin KENDİ KADROSUNDAKİ personeli aktif/pasif yapma fonksiyonu
CREATE OR REPLACE FUNCTION public.toggle_manager_user_status(p_target_user_id UUID, p_new_status BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller_role user_role;
  v_caller_district INTEGER;
  v_caller_province SMALLINT;
  v_target_district INTEGER;
  v_target_province SMALLINT;
BEGIN
  -- Kendi yetkilerini çek
  SELECT role, district_id, province_id INTO v_caller_role, v_caller_district, v_caller_province
  FROM public.profiles WHERE id = auth.uid();

  -- Hedef kullanıcının yetki bölgesini çek
  SELECT district_id, province_id INTO v_target_district, v_target_province
  FROM public.profiles WHERE id = p_target_user_id;

  -- Yetki Kontrolleri
  IF v_caller_role = 'super_admin' THEN
     -- Süper admin herkesi değiştirebilir
  ELSIF v_caller_role = 'province_admin' THEN
     IF v_target_province IS DISTINCT FROM v_caller_province THEN
       RETURN jsonb_build_object('success', false, 'message', 'Bu kullanıcı sizin ilinizde değil. Değişiklik yapamazsınız.');
     END IF;
  ELSIF v_caller_role = 'district_admin' THEN
     IF v_target_district IS DISTINCT FROM v_caller_district THEN
       RETURN jsonb_build_object('success', false, 'message', 'Bu kullanıcı sizin ilçenizde değil. Değişiklik yapamazsınız.');
     END IF;
  ELSE
     RETURN jsonb_build_object('success', false, 'message', 'Yetkiniz yetersiz.');
  END IF;

  UPDATE public.profiles
  SET is_active = p_new_status, updated_at = NOW()
  WHERE id = p_target_user_id;

  RETURN jsonb_build_object('success', true, 'message', 'Kullanıcı durumu başarıyla güncellendi.');
END;
$$;
