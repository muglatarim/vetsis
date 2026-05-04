# VETSİS - Veteriner Bilgi Sistemi

> Muğla İl Tarım ve Orman Müdürlüğü için geliştirilmiş, arı işletmelerini takip eden web tabanlı veteriner yönetim sistemi.

## 🚀 Teknolojiler

| Teknoloji | Kullanım |
|-----------|----------|
| React 18 + Vite | Frontend framework |
| Supabase | Backend (PostgreSQL + Auth + RLS) |
| React Leaflet | İnteraktif harita |
| Zustand | Global state yönetimi |
| XLSX | Excel import |
| Dexie (IndexedDB) | Offline cache |

## ⚙️ Kurulum

### Gereksinimler
- Node.js 18+
- Bir Supabase projesi
- (Opsiyonel) XAMPP – harita/veri dosyaları için yerel proxy

### 1. Repoyu klonla

```bash
git clone https://github.com/KULLANICI_ADI/vetsis.git
cd vetsis
```

### 2. Bağımlılıkları yükle

```bash
npm install
```

### 3. Ortam değişkenlerini ayarla

`.env.example` dosyasını kopyalayıp `.env` olarak yeniden adlandır:

```bash
copy .env.example .env
```

Ardından `.env` içindeki değerleri kendi Supabase projenizin bilgileriyle doldurun:

```env
VITE_SUPABASE_URL=https://PROJE_ID.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
VITE_HASH_SALT=GucluVeGizliBirSifreSalt
```

### 4. Veritabanını kur

Supabase SQL Editor'de `sql/` klasöründeki dosyaları **sırasıyla** çalıştır:

```
01_schema.sql          → Tablo yapıları
02_rls_policies.sql    → Satır güvenlik politikaları
03_functions.sql       → PostgreSQL fonksiyonları
04_seed_1_iller_ilceler.sql   → İl/ilçe seed verisi
04_seed_2_mahalleler_part1.sql → Mahalle seed (bölüm 1)
04_seed_3_mahalleler_part2.sql → Mahalle seed (bölüm 2)
04_seed_4_mahalleler_part3.sql → Mahalle seed (bölüm 3)
05_rls_fix.sql  → ve sonrası (sırasıyla)
...
15_refactor_enterprises.sql
```

> ⚠️ `04_seed.sql` kişisel veri içerdiğinden repo'ya eklenmemiştir.

### 5. Geliştirme sunucusunu başlat

```bash
npm run dev
```

Uygulama `http://localhost:5173` adresinde açılacaktır.

## 📂 Proje Yapısı

```
vetsis/
├── src/
│   ├── components/      # Yeniden kullanılabilir UI bileşenleri
│   ├── context/         # React context (auth vb.)
│   ├── lib/             # Supabase istemcisi
│   ├── pages/           # Sayfa bileşenleri
│   ├── utils/           # Yardımcı fonksiyonlar (crypto, excel...)
│   ├── App.jsx
│   └── main.jsx
├── sql/                 # Veritabanı kurulum scriptleri
├── public/
│   ├── maps/            # GeoJSON harita dosyaları
│   └── data/            # Statik veri dosyaları
├── .env.example         # Örnek ortam değişkenleri
├── index.html
├── vite.config.js
└── package.json
```

## 🔒 Güvenlik

- `.env` dosyası repo'ya dahil **edilmez** — gerçek anahtarlarınızı asla commit etmeyin.
- TC kimlik numaraları, SHA-256 + salt ile hashlenerek saklanır (KVKK uyumlu).
- Supabase Row Level Security (RLS) tüm tablolarda aktiftir.

## 📋 Özellikler

- 🗺️ İnteraktif harita üzerinde işletme takibi
- 📊 Excel dosyasından toplu işletme/hayvan aktarımı
- 👥 Kullanıcı ve rol yönetimi (admin/veteriner)
- 📅 Günlük görev ve ziyaret kaydı
- 📈 Kampanya ve sürü takibi
- 🔐 KVKK uyumlu kişisel veri maskeleme

## 📄 Lisans

Bu proje Muğla İl Tarım ve Orman Müdürlüğü için geliştirilmiştir. Tüm hakları saklıdır.
