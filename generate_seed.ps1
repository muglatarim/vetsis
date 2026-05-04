# =====================================================================
# VETSİS — Seed Veri Üreticisi (Parçalanmış Çıktı)
# Kaynak: tum_turkiye.csv (Il, Ilce, Mahalle — 52.629 satir)
# Cikti:  sql/04_seed_1...sql, 04_seed_2...sql şeklinde ayrılmış dosyalar
# =====================================================================

$CsvPath    = Join-Path $PSScriptRoot "tum_turkiye.csv"
$OutputDir  = Join-Path $PSScriptRoot "sql"

Write-Host "VETSİS Seed Üreticisi Başladı..." -ForegroundColor Cyan

# ---- Plaka kodu eşleştirme (81 il) ----
$plateCode = @{
  'ADANA'=1;'ADIYAMAN'=2;'AFYONKARAHİSAR'=3;'AĞRI'=4;'AMASYA'=5;
  'ANKARA'=6;'ANTALYA'=7;'ARTVİN'=8;'AYDIN'=9;'BALIKESİR'=10;
  'BİLECİK'=11;'BİNGÖL'=12;'BİTLİS'=13;'BOLU'=14;'BURDUR'=15;
  'BURSA'=16;'ÇANAKKALE'=17;'ÇANKIRI'=18;'ÇORUM'=19;'DENİZLİ'=20;
  'DİYARBAKIR'=21;'EDİRNE'=22;'ELAZIĞ'=23;'ERZİNCAN'=24;'ERZURUM'=25;
  'ESKİŞEHİR'=26;'GAZİANTEP'=27;'GİRESUN'=28;'GÜMÜŞHANE'=29;'HAKKARİ'=30;
  'HATAY'=31;'ISPARTA'=32;'MERSİN'=33;'İSTANBUL'=34;'İZMİR'=35;
  'KARS'=36;'KASTAMONU'=37;'KAYSERİ'=38;'KIRKLARELİ'=39;'KIRŞEHİR'=40;
  'KOCAELİ'=41;'KONYA'=42;'KÜTAHYA'=43;'MALATYA'=44;'MANİSA'=45;
  'KAHRAMANMARAŞ'=46;'MARDİN'=47;'MUĞLA'=48;'MUŞ'=49;'NEVŞEHİR'=50;
  'NİĞDE'=51;'ORDU'=52;'RİZE'=53;'SAKARYA'=54;'SAMSUN'=55;
  'SİİRT'=56;'SİNOP'=57;'SİVAS'=58;'TEKİRDAĞ'=59;'TOKAT'=60;
  'TRABZON'=61;'TUNCELİ'=62;'ŞANLIURFA'=63;'UŞAK'=64;'VAN'=65;
  'YOZGAT'=66;'ZONGULDAK'=67;'AKSARAY'=68;'BAYBURT'=69;'KARAMAN'=70;
  'KIRIKKALE'=71;'BATMAN'=72;'ŞIRNAK'=73;'BARTIN'=74;'ARDAHAN'=75;
  'IĞDIR'=76;'YALOVA'=77;'KARABÜK'=78;'KİLİS'=79;'OSMANİYE'=80;
  'DÜZCE'=81
}

function Escape-Sql($s) { return $s -replace "'", "''" }

# ---- CSV Oku ----
Write-Host "CSV okunuyor: $CsvPath" -ForegroundColor Yellow
$rows = [System.IO.File]::ReadAllText($CsvPath, [System.Text.Encoding]::UTF8) |
  ConvertFrom-Csv | Where-Object { $_.'İl' -and $_.'İlçe' -and $_.'Mahalle' }

# ---- Veri Yapıları ----
$provinces     = [ordered]@{}
$districts     = [ordered]@{}
$neighbourhoods = [System.Collections.Generic.List[hashtable]]::new()

$districtCounter = 0

foreach ($row in $rows) {
  $ilName  = $row.'İl'.Trim().ToUpper()
  $ilceStr = $row.'İlçe'.Trim().ToUpper()
  $mahStr  = $row.'Mahalle'.Trim().ToUpper()

  # Province
  if (-not $provinces.Contains($ilName)) {
    if ($plateCode.ContainsKey($ilName)) {
      $provinces[$ilName] = $plateCode[$ilName]
    } else {
      $provinces[$ilName] = 99
    }
  }

  # District
  $distKey = "$ilName|$ilceStr"
  if (-not $districts.Contains($distKey)) {
    $districtCounter++
    $districts[$distKey] = @{ id = $districtCounter; prov = $ilName }
  }

  # Neighbourhood
  $neighbourhoods.Add(@{
    district_key = $distKey
    name         = $mahStr
  })
}

# =====================================================================
# BÖLÜM 1: İL VE İLÇELER
# =====================================================================
$part1 = Join-Path $OutputDir "04_seed_1_iller_ilceler.sql"
$sb1 = [System.Text.StringBuilder]::new()
[void]$sb1.AppendLine("BEGIN;")

# Provinces
[void]$sb1.AppendLine("INSERT INTO provinces (id, name) VALUES")
$provLines = @()
foreach ($il in $provinces.GetEnumerator()) {
  $name = Escape-Sql $il.Key
  $provLines += "  ($($il.Value), '$name')"
}
[void]$sb1.AppendLine(($provLines -join ",`n"))
[void]$sb1.AppendLine("ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;")
[void]$sb1.AppendLine("")

# Districts
[void]$sb1.AppendLine("INSERT INTO districts (id, province_id, name) VALUES")
$distLines = @()
foreach ($dist in $districts.GetEnumerator()) {
  $parts  = $dist.Key.Split('|')
  $provCode = $provinces[$parts[0]]
  $distId   = $dist.Value.id
  $esc      = Escape-Sql $parts[1]
  $distLines += "  ($distId, $provCode, '$esc')"
}
[void]$sb1.AppendLine(($distLines -join ",`n"))
[void]$sb1.AppendLine("ON CONFLICT (province_id, name) DO UPDATE SET name = EXCLUDED.name;")
[void]$sb1.AppendLine("SELECT setval('districts_id_seq', $districtCounter, true);")
[void]$sb1.AppendLine("COMMIT;")

[System.IO.File]::WriteAllText($part1, $sb1.ToString(), [System.Text.Encoding]::UTF8)
Write-Host "✅ Oluşturuldu: 04_seed_1_iller_ilceler.sql"

# =====================================================================
# BÖLÜM 2+: MAHALLELER (Her dosya max ~18.000 mahalle alacak, ~400KB)
# =====================================================================
$total = $neighbourhoods.Count
$itemsPerFile = 18000
$fileCount = [math]::Ceiling($total / $itemsPerFile)

for ($i = 0; $i -lt $fileCount; $i++) {
    $fileIndex = $i + 2
    $partPath = Join-Path $OutputDir "04_seed_$($fileIndex)_mahalleler_part$($i+1).sql"
    
    $sb = [System.Text.StringBuilder]::new()
    [void]$sb.AppendLine("BEGIN;")
    
    $startIdx = $i * $itemsPerFile
    $endIdx   = [math]::Min($startIdx + $itemsPerFile, $total) - 1
    
    # 500'erli insert blokları
    for ($j = $startIdx; $j -le $endIdx; $j += 500) {
        $chunkEnd = [math]::Min($j + 500, $endIdx + 1) - 1
        $batch = $neighbourhoods[$j..$chunkEnd]
        
        [void]$sb.AppendLine("INSERT INTO neighbourhoods (district_id, name) VALUES")
        $mLines = @()
        foreach ($mah in $batch) {
            $distId   = $districts[$mah.district_key].id
            $mahName  = Escape-Sql $mah.name
            $mLines  += "  ($distId, '$mahName')"
        }
        [void]$sb.AppendLine(($mLines -join ",`n"))
        [void]$sb.AppendLine("ON CONFLICT (district_id, name) DO NOTHING;")
        [void]$sb.AppendLine("")
    }
    
    [void]$sb.AppendLine("COMMIT;")
    [System.IO.File]::WriteAllText($partPath, $sb.ToString(), [System.Text.Encoding]::UTF8)
    Write-Host "✅ Oluşturuldu: 04_seed_$($fileIndex)_mahalleler_part$($i+1).sql"
}

Write-Host "==============================================" -ForegroundColor Green
Write-Host " BAŞARILI! Dosyalar Supabase limitlerine göre bölündü." -ForegroundColor Green
Write-Host " Lütfen SQL Editör'de sırayla çalıştırın:" -ForegroundColor Yellow
Write-Host " 1. 04_seed_1_iller_ilceler.sql"
for ($i = 0; $i -lt $fileCount; $i++) {
    Write-Host " $($i+2). 04_seed_$($i+2)_mahalleler_part$($i+1).sql"
}
Write-Host "==============================================" -ForegroundColor Green

