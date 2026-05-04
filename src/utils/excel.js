import * as XLSX from 'xlsx'
import { sha256Hash, maskName, maskTC, validateAndFormatEnterpriseId } from './crypto'

/**
 * Excel dosyasını dinamik başlıklarla okur
 * @returns { headers: string[], rows: object[] }
 */
export function parseExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result)
        const wb = XLSX.read(data, { type: 'array', codepage: 1254 }) // Türkçe karakter desteği
        const ws = wb.Sheets[wb.SheetNames[0]]

        // Ham veriyi satır satır okuruz.
        const rawData = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

        let headerRowIndex = -1
        let headers = []

        // Bakanlık Excel'lerinde başlıklar ilk satırda değil, 10-15 civarında olur.
        for (let i = 0; i < Math.min(50, rawData.length); i++) {
          const rowStr = rawData[i].map(c => String(c).toLocaleUpperCase('tr-TR').trim()).join(' ')
          if (
            rowStr.includes('İŞLETME NUMARASI') ||
            rowStr.includes('ISLETME NO') ||
            rowStr.includes('İŞLETME NO') ||
            rowStr.includes('NO')
          ) {
            headerRowIndex = i
            headers = rawData[i]
            break
          }
        }

        if (headerRowIndex === -1) {
          throw new Error("Geçerli bir Excel başlık satırı bulunamadı ('İşletme Numarası' veya 'İşletme No' bekleniyor).")
        }

        const rows = []
        for (let i = headerRowIndex + 1; i < rawData.length; i++) {
          const rowArray = rawData[i]
          if (rowArray.join('').trim() === '') continue

          const rowObj = {}
          for (let j = 0; j < headers.length; j++) {
            const headerName = String(headers[j] || '').replace(/\s+/g, ' ').trim().toLocaleUpperCase('tr-TR')
            if (headerName) rowObj[headerName] = rowArray[j]
          }
          rows.push(rowObj)
        }

        resolve({ headers, rows })
      } catch (err) {
        reject(new Error('Excel dosyası okunamadı: ' + err.message))
      }
    }
    reader.onerror = () => reject(new Error('Dosya okuma hatası'))
    reader.readAsArrayBuffer(file)
  })
}

/**
 * İşletme Detay Listesi.xls işleme
 * KVKK politikası:
 *   - Gerçek isim/TC asla kaydedilmez
 *   - Sadece maskeli ad, soyad, baba adı ve TC hash + maskeli değer tutulur
 *
 * @param {object[]} rows
 * @param {number}   plateCode  - Yetkili ilin plaka kodu (örn: 48)
 * @returns {object[]}
 */
export async function processEnterpriseDetailRows(rows, plateCode) {
  const results = []
  const errors = []

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx]
    const normalized = {}
    for (const [k, v] of Object.entries(row)) {
      normalized[k.replace(/\s+/g, ' ').trim().toLocaleUpperCase('tr-TR')] = String(v ?? '').trim()
    }

    // ── İşletme No ──────────────────────────────────────────
    const rawNo = (
      normalized['İŞLETME NUMARASI'] ||
      normalized['İŞLETME NO'] ||
      normalized['ISLETME NO'] ||
      normalized['NO'] ||
      ''
    )
    if (!rawNo) continue   // boş satır

    let enterpriseId
    try {
      enterpriseId = validateAndFormatEnterpriseId(rawNo, plateCode)
    } catch (err) {
      errors.push(`Satır ${idx + 2}: ${err.message}`)
      continue   // hatalı satırı atla, diğerlerine devam et
    }

    // ── TC / VKN (aynı sütunda) ──────────────────────────────
    const rawIdNo = (
      normalized['TC/VERGİ NO'] ||
      normalized['TC / VERGİ NO'] ||
      normalized['T.C. KİMLİK/VERGİ NUMARASI'] ||
      normalized['T.C. Kimlik/Vergi Numarası'] ||
      normalized['T.C. KİMLİK / VERGİ NUMARASI'] ||
      normalized['T.C. KİMLİK NO/VERGİ NUMARASI'] ||
      normalized['TC KİMLİK NO'] ||
      normalized['TCKN'] ||
      normalized['VERGİ KİMLİK NO'] ||
      normalized['VKN'] ||
      ''
    )
    const cleanedIdNo = rawIdNo.replace(/\D/g, '')   // sadece rakamlar

    const tcHash = cleanedIdNo ? await sha256Hash(cleanedIdNo) : null
    const tcMasked = cleanedIdNo ? maskTC(cleanedIdNo) : null

    // ── Kişisel Bilgiler (Maskeli) ────────────────────────────
    const ownerNameRaw = (
      normalized['İŞLETME SAHİBİ AD'] ||
      normalized['İŞLETME SAHİBİ ADI'] ||
      ''
    )
    const ownerSurnameRaw = (
      normalized['İŞLETME SAHİBİ SOYAD'] ||
      normalized['İŞLETME SAHİBİ SOYADI'] ||
      ''
    )
    const fatherRaw = (
      normalized['BABA ADI'] ||
      normalized['BABA'] ||
      ''
    )

    // Telefon 2 önceliği, sonra Telefon 1
    const phone = (
      normalized['TELEFON 2'] ||
      normalized['TELEFON2'] ||
      normalized['TELEFON 1'] ||
      normalized['TELEFON1'] ||
      normalized['TELEFON'] ||
      normalized['GSM'] ||
      normalized['CEP'] ||
      ''
    )

    // Mahalle
    const neighbourhood = (
      normalized['MAHALLE/KÖY'] ||
      normalized['KÖY/MAHALLE'] ||
      normalized['YERLEŞİM YERİ'] ||
      normalized['MAHALLE'] ||
      normalized['KÖY'] ||
      ''
    )

    results.push({
      enterprise_id: enterpriseId,
      owner_name_masked: ownerNameRaw ? maskName(ownerNameRaw) : null,
      owner_surname_masked: ownerSurnameRaw ? maskName(ownerSurnameRaw) : null,
      father_name_masked: fatherRaw ? maskName(fatherRaw) : null,
      tc_hash: tcHash,
      tc_masked: tcMasked,
      phone: phone || null,
      neighbourhood: neighbourhood || null,
      extra_data: null,
    })
  }

  return { results, errors }
}

/**
 * İşletme Listesi.xls (Hayvan Sayıları) işleme
 * @param {object[]} rows
 * @param {number}   plateCode
 * @returns {{ results: object[], errors: string[], neighbourhoods: string[] }}
 *   neighbourhoods: Excel'de bulunan benzersiz mahalle adları listesi (sıfırlama için)
 */
export function processAnimalCountRows(rows, plateCode) {
  const results = []
  const errors = []
  const neighbourhoodSet = new Set()

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx]
    const normalized = {}
    for (const [k, v] of Object.entries(row)) {
      normalized[k.replace(/\s+/g, ' ').trim().toLocaleUpperCase('tr-TR')] = String(v ?? '').trim()
    }

    const rawNo = (
      normalized['İŞLETME NO'] ||
      normalized['ISLETME NO'] ||
      normalized['NO'] ||
      ''
    )
    if (!rawNo) continue

    let enterpriseId
    try {
      enterpriseId = validateAndFormatEnterpriseId(rawNo, plateCode)
    } catch (err) {
      errors.push(`Satır ${idx + 2}: ${err.message}`)
      continue
    }

    const mahalle = (
      normalized['KÖY/MAHALLE'] ||
      normalized['MAHALLE/KÖY'] ||
      normalized['YERLEŞİM YERİ'] ||
      normalized['MAHALLE'] ||
      normalized['KÖY'] ||
      ''
    ).trim()

    if (mahalle) neighbourhoodSet.add(mahalle.toLocaleUpperCase('tr-TR'))

    let sigir = 0, manda = 0, koyun = 0, keci = 0
    for (const [k, v] of Object.entries(normalized)) {
      if (k.includes('SIĞIR')) sigir = parseInt(v, 10) || 0
      if (k.includes('MANDA')) manda = parseInt(v, 10) || 0
      if (k.includes('KOYUN')) koyun = parseInt(v, 10) || 0
      if (k.includes('KEÇİ')) keci = parseInt(v, 10) || 0
    }

    results.push({ enterprise_id: enterpriseId, neighbourhood: mahalle, sigir, manda, koyun, keci })
  }

  return { results, errors, neighbourhoods: [...neighbourhoodSet] }
}
