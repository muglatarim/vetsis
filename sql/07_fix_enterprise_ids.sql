-- ============================================================
-- SQL Script: İşletme Numaralarını Stardartlaştırma (ÇAKIŞMA ÇÖZÜCÜ)
-- Eğer dönüştürülecek işletme numarası veritabanında zaten varsa (Örn TR480001007116),
-- eski numaradaki (Örn 1007116) sürüleri yeni numaraya taşıyıp eski hatalı işletmeyi siler (Merge).
-- Eğer yoksa direkt ismini değiştirir.
-- ============================================================

DO $$
DECLARE
  rec RECORD;
  v_new_id TEXT;
  v_exists BOOLEAN;
  v_herd_rec RECORD;
BEGIN
  -- 1. ADIM: "TR4848" ile başlayanları ve salt rakam olanları bulup loop içine alalım
  FOR rec IN 
    SELECT id FROM public.enterprises 
    WHERE id LIKE 'TR4848%' OR id ~ '^[0-9]+$'
  LOOP
    -- Yeni ID'yi hesapla
    IF rec.id LIKE 'TR4848%' THEN
      v_new_id := 'TR' || substring(rec.id from 5);
    ELSE
      v_new_id := 'TR48' || lpad(rec.id, 10, '0');
    END IF;

    -- Eğer yeni ID şans eseri aynıysa (olmaz ama) atla
    IF v_new_id = rec.id THEN CONTINUE; END IF;

    -- Hedefte bu ID önceden oluşturulmuş mu? (Çakışma kontrolü)
    SELECT EXISTS (SELECT 1 FROM public.enterprises WHERE id = v_new_id) INTO v_exists;

    IF NOT v_exists THEN
      -- Çakışma yoksa direkt UPDATE yap (ON UPDATE CASCADE her şeyi otomatik halledecek)
      UPDATE public.enterprises SET id = v_new_id WHERE id = rec.id;
    ELSE
      -- ÇAKIŞMA VAR! (Eski kayıttaki süreleri ve verileri asıl doğru kayda aktarıyoruz)
      
      -- Önce eski işletmedeki sürüleri (herds) doğru olan enterprise_id'ye kaydırıyoruz.
      -- UNIQUE(enterprise_id, herd_number) patlamaması için herd_number'ı yeniden yapılandırıyoruz
      FOR v_herd_rec IN SELECT id, herd_number FROM public.herds WHERE enterprise_id = rec.id LOOP
        UPDATE public.herds 
        SET 
          enterprise_id = v_new_id,
          -- Ana kayıttaki maksimum sürü numarasının 1 fazlasını vererek üstüne ekliyoruz
          herd_number = (SELECT COALESCE(MAX(herd_number), 0) + 1 FROM public.herds WHERE enterprise_id = v_new_id)
        WHERE id = v_herd_rec.id;
      END LOOP;

      -- Temp işletmelerdeki reference'ı aktar
      UPDATE public.temp_enterprises SET real_id = v_new_id WHERE real_id = rec.id;

      -- Hayvan Sayılarını Ana Kayıtta Topla/Aktar (Eğer eski kayıtta hayvan varsa asıl kayda eklensin)
      UPDATE public.enterprises AS e
      SET 
        sigir_count = e.sigir_count + (SELECT sigir_count FROM public.enterprises WHERE id = rec.id),
        manda_count = e.manda_count + (SELECT manda_count FROM public.enterprises WHERE id = rec.id),
        koyun_count = e.koyun_count + (SELECT koyun_count FROM public.enterprises WHERE id = rec.id),
        keci_count  = e.keci_count  + (SELECT keci_count FROM public.enterprises WHERE id = rec.id)
      WHERE id = v_new_id;

      -- Artık içi boşaltılan eski hatalı işletmeyi silebiliriz (ON DELETE CASCADE ile tüm çöpler temizlenir)
      DELETE FROM public.enterprises WHERE id = rec.id;
    
    END IF;
  END LOOP;
END;
$$;
