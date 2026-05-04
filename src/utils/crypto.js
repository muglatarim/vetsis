/**
 * SHA-256 + Salt ile veri şifreleme (TC, VKN)
 * Şifreleme tarayıcıda gerçekleşir — sunucuya ham veri gönderilmez!
 * HTTP ortamında (XAMPP) crypto.subtle yoksa saf JS implementasyonu kullanılır.
 */
const SALT = import.meta.env.VITE_HASH_SALT || 'VetSis2026Default'

/** Saf JS SHA-256 — secure context (HTTPS) olmayan ortamlar için fallback */
function _sha256Fallback(str) {
  const K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ]
  const rotr = (x, n) => (x >>> n) | (x << (32 - n))
  const bytes   = new TextEncoder().encode(str)
  const bitLen  = bytes.length * 8
  const padLen  = Math.ceil((bytes.length + 9) / 64) * 64
  const padded  = new Uint8Array(padLen)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const dv = new DataView(padded.buffer)
  dv.setUint32(padLen - 8, 0, false)
  dv.setUint32(padLen - 4, bitLen, false)
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]
  for (let i = 0; i < padLen; i += 64) {
    const w = []
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false)
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(w[j-15],7) ^ rotr(w[j-15],18) ^ (w[j-15] >>> 3)
      const s1 = rotr(w[j-2],17) ^ rotr(w[j-2],19)  ^ (w[j-2]  >>> 10)
      w[j] = (w[j-16] + s0 + w[j-7] + s1) | 0
    }
    let [a,b,c,d,e,f,g,hh] = h
    for (let j = 0; j < 64; j++) {
      const t1 = (hh + (rotr(e,6)^rotr(e,11)^rotr(e,25)) + ((e&f)^(~e&g)) + K[j] + w[j]) | 0
      const t2 = ((rotr(a,2)^rotr(a,13)^rotr(a,22)) + ((a&b)^(a&c)^(b&c))) | 0
      hh=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0
    }
    h[0]=(h[0]+a)|0; h[1]=(h[1]+b)|0; h[2]=(h[2]+c)|0; h[3]=(h[3]+d)|0
    h[4]=(h[4]+e)|0; h[5]=(h[5]+f)|0; h[6]=(h[6]+g)|0; h[7]=(h[7]+hh)|0
  }
  return h.map(x => (x >>> 0).toString(16).padStart(8,'0')).join('')
}

export async function sha256Hash(value) {
  if (!value) return null
  const input = SALT + String(value).trim()
  // HTTPS / localhost → Web Crypto API (hızlı, native)
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const data = new TextEncoder().encode(input)
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const hashArray  = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  }
  // HTTP / güvensiz bağlam → saf JS fallback
  return _sha256Fallback(input)
}

/**
 * Metni maskele: İlk ve son karakter görünür, arası *
 * "İBRAHİM" → "İ*****M"
 * "YILMAZ"  → "Y****Z"
 */
export function maskName(name) {
  if (!name || name.trim().length === 0) return ''
  const parts = name.trim().split(/\s+/)
  return parts.map(part => {
    if (part.length <= 2) return part[0] + '*'
    return part[0] + '*'.repeat(part.length - 2) + part[part.length - 1]
  }).join(' ')
}

/**
 * TC numarası maskeleme: "12345678901" → "1*****7890**1" gibi
 * İlk 1 ve son 1 karakter görünür
 */
export function maskTC(tc) {
  if (!tc) return ''
  const s = String(tc).trim()
  if (s.length <= 2) return s
  return s[0] + '*'.repeat(s.length - 2) + s[s.length - 1]
}

/**
 * VKN maskeleme (10 hane): İlk 2 ve son 2 görünür
 * "1234567890" → "12******90"
 */
export function maskVKN(vkn) {
  if (!vkn) return ''
  const s = String(vkn).trim().padStart(10, '0')
  if (s.length <= 4) return s
  return s.slice(0, 2) + '*'.repeat(s.length - 4) + s.slice(-2)
}

/**
 * VKN'yi 10 haneye tamamla
 * "123" → "0000000123"
 */
export function padVKN(vkn) {
  if (!vkn) return ''
  return String(vkn).trim().padStart(10, '0')
}

/**
 * İşletme No doğrulama ve formatlama
 * Kurallar:
 *   - "TR" + plakaKodu ile başlamalı (örn: TR48...)
 *   - Toplam uzunluk en az 12 karakter olmalı
 *   - Uymayan kayıtlar için Error fırlatılır (yükleme durur)
 * @param {string|number} val        - Ham değer (excelden gelen)
 * @param {number}        plateCode  - Yetkili ildeki plaka kodu (örn: 48)
 * @returns {string} Doğrulanmış işletme no (örn: TR480000000021)
 * @throws {Error} Format uyumsuzsa
 */
export function validateAndFormatEnterpriseId(val, plateCode) {
  if (!val) return null
  const str = String(val).toUpperCase().trim()

  // Zaten doğru formatsa (TR + sayılar, min 12 karakter) olduğu gibi döndür
  if (/^TR\d{10,}$/.test(str)) {
    const expectedPrefix = `TR${String(plateCode).padStart(2, '0')}`
    if (!str.startsWith(expectedPrefix)) {
      throw new Error(
        `İşletme No "${str}" bu ile ait değil! Beklenen prefix: ${expectedPrefix} — Excel doğru dosya mı?`
      )
    }
    return str
  }

  throw new Error(
    `"${val}" geçerli bir işletme numarası formatında değil. Beklenen format: TR${String(plateCode).padStart(2, '0')}XXXXXXXXXX`
  )
}

/**
 * @deprecated validateAndFormatEnterpriseId kullanın
 * Eski padding mantığı — geriye dönük uyumluluk için bırakıldı
 */
export function padEnterpriseId(val, plateCode) {
  return validateAndFormatEnterpriseId(val, plateCode)
}

/**
 * Eksik olan veya kısa girilen işletme numarasını formatlar
 * Örn: "21" -> "TR480000000021" (Muğla için)
 */
export function formatPartialEnterpriseId(val, plateCode) {
  if (!val) return null
  let str = String(val).toUpperCase().trim()
  
  // Sadece rakamlardan oluşuyorsa TR + Plaka + Padding ekle
  if (/^\d+$/.test(str)) {
    const prefix = `TR${String(plateCode).padStart(2, '0')}`
    // Eğer girilen rakam zaten TR+Plaka ile başlıyormuş gibi uzunsa (örn 4800001)
    // onu bozmamak için sadece başına TR ekle veya 12 haneye tamamla
    if (str.startsWith(String(plateCode).padStart(2, '0')) && str.length >= 10) {
      return 'TR' + str
    }
    return prefix + str.padStart(10, '0')
  }
  
  // Zaten TR ile başlıyorsa ama kısaysa tamamla
  if (/^TR\d+$/.test(str)) {
    const nums = str.substring(2)
    const prefix = `TR${String(plateCode).padStart(2, '0')}`
    if (nums.length < 10) {
       return prefix + nums.padStart(10, '0')
    }
    return str
  }

  return str
}

/**
 * TEMP ID üretici
 * Örn: TEMP-20260410-X4K2P
 */
export function generateTempId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const rand  = Math.random().toString(36).substring(2, 7).toUpperCase()
  return `TEMP-${date}-${rand}`
}
