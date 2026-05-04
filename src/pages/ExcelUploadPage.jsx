import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { parseExcel, processEnterpriseDetailRows, processAnimalCountRows } from '../utils/excel'

export default function ExcelUploadPage() {
  const { profile, canUploadExcel } = useAuth()
  const [activeTab, setActiveTab] = useState('detail')   // 'detail' | 'animals'
  const [file, setFile] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState({ current: 0, total: 0 })
  const [results, setResults] = useState(null)
  const [parseErrors, setParseErrors] = useState([])   // İşletme No format hataları
  const [error, setError] = useState('')

  if (!canUploadExcel) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '3rem', color: 'var(--color-muted)' }}>
        ⛔ Bu sayfaya erişim yetkiniz yok.
      </div>
    )
  }

  const districtId = profile?.district_id
  // provinces.id İl plaka kodudur (01–81). super_admin/province_admin için kök il
  const plateCode = profile?.province_id ?? null

  if (!plateCode) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '3rem', color: 'var(--color-warning)' }}>
        ⚠️ Profilinizde il bilgisi atanmamış. Lütfen yönetici ile iletişime geçin.
      </div>
    )
  }

  function handleDrop(e) {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) setFile(f)
  }

  async function handleUpload() {
    if (!file) { setError('Dosya seçin'); return }
    if (!districtId) { setError('Profilinizde ilçe atanmamış'); return }

    setProcessing(true)
    setError('')
    setResults(null)
    setParseErrors([])

    try {
      const { rows } = await parseExcel(file)

      if (activeTab === 'detail') {
        await uploadDetailExcel(rows)
      } else {
        await uploadAnimalExcel(rows)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setProcessing(false)
    }
  }

  // ── İşletme Detay Listesi yükleme ──────────────────────────
  async function uploadDetailExcel(rows) {
    const { results: processed, errors: rowErrors } = await processEnterpriseDetailRows(rows, plateCode)

    if (rowErrors.length > 0) setParseErrors(rowErrors)
    if (processed.length === 0) {
      throw new Error('Geçerli kayıt bulunamadı. Lütfen doğru dosyayı yüklediğinizden emin olun.')
    }

    setProgress({ current: 0, total: processed.length })

    let success = 0, failed = 0
    let firstRpcError = null
    const BATCH = 50

    for (let i = 0; i < processed.length; i += BATCH) {
      const batch = processed.slice(i, i + BATCH)

      for (const row of batch) {
        const { error: err } = await supabase.rpc('upsert_enterprise_from_excel', {
          p_enterprise_id: row.enterprise_id,
          p_district_id: districtId,
          p_neighbourhood: row.neighbourhood,
          p_owner_masked: row.owner_name_masked,
          p_owner_surname_masked: row.owner_surname_masked,
          p_father_masked: row.father_name_masked,
          p_tc_hash: row.tc_hash,
          p_tc_masked: row.tc_masked,
          p_phone: row.phone,
          p_extra_data: row.extra_data,
        })
        if (err) {
          failed++
          if (!firstRpcError) firstRpcError = `${row.enterprise_id}: ${err.message}`
        } else {
          success++
        }
        setProgress(p => ({ ...p, current: p.current + 1 }))
      }
    }

    setResults({ success, failed, skipped: rowErrors.length, total: processed.length + rowErrors.length, type: 'detail' })
    if (firstRpcError) setError('RPC Hata örneği: ' + firstRpcError)
  }

  // ── İşletme Hayvan Sayısı yükleme ──────────────────────────
  async function uploadAnimalExcel(rows) {
    const { results: processed, errors: rowErrors, neighbourhoods } = processAnimalCountRows(rows, plateCode)

    if (rowErrors.length > 0) setParseErrors(rowErrors)
    if (processed.length === 0) {
      throw new Error('Geçerli kayıt bulunamadı. Lütfen doğru dosyayı yüklediğinizden emin olun.')
    }

    // ADIM 1: Sadece excelde geçen mahalleleri sıfırla
    if (neighbourhoods.length > 0) {
      const { error: resetErr } = await supabase.rpc('reset_neighbourhood_animal_counts', {
        p_district_id: districtId,
        p_neighbourhood_names: neighbourhoods,
      })
      if (resetErr) throw new Error('Mahalle sıfırlama hatası: ' + resetErr.message)
    }

    // ADIM 2: Yeni verileri upsert et
    setProgress({ current: 0, total: processed.length })

    let success = 0, failed = 0
    let firstRpcError = null
    const BATCH = 100

    for (let i = 0; i < processed.length; i += BATCH) {
      const batch = processed.slice(i, i + BATCH)

      for (const row of batch) {
        if (row.sigir + row.manda + row.koyun + row.keci === 0) {
          setProgress(p => ({ ...p, current: p.current + 1 }))
          continue
        }
        const { error: err } = await supabase.rpc('upsert_enterprise_from_excel', {
          p_enterprise_id: row.enterprise_id,
          p_district_id: districtId,
          p_neighbourhood: row.neighbourhood,
          p_sigir: row.sigir,
          p_manda: row.manda,
          p_koyun: row.koyun,
          p_keci: row.keci,
        })
        if (err) {
          failed++
          if (!firstRpcError) firstRpcError = `${row.enterprise_id}: ${err.message}`
        } else {
          success++
        }
        setProgress(p => ({ ...p, current: p.current + 1 }))
      }
    }

    setResults({
      success, failed,
      skipped: rowErrors.length,
      total: processed.length + rowErrors.length,
      type: 'animals',
      neighbourhoods,
    })
    if (firstRpcError) setError('RPC Hata örneği: ' + firstRpcError)
  }

  const pct = progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0

  return (
    <div style={{ maxWidth: 680, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: '1.5rem' }}>
        📊 Excel Yükleme
      </h1>

      {/* Sekme */}
      <div style={{ display: 'flex', gap: '.5rem', marginBottom: '1.5rem' }}>
        <button
          id="tab-detail"
          className={`btn ${activeTab === 'detail' ? 'btn--primary' : 'btn--ghost'}`}
          onClick={() => { setActiveTab('detail'); setFile(null); setResults(null); setParseErrors([]) }}
        >
          📋 İşletme Detay Listesi
        </button>
        <button
          id="tab-animals"
          className={`btn ${activeTab === 'animals' ? 'btn--primary' : 'btn--ghost'}`}
          onClick={() => { setActiveTab('animals'); setFile(null); setResults(null); setParseErrors([]) }}
        >
          🐄 Hayvan Sayısı Listesi
        </button>
      </div>

      {/* Bilgi Kutusu */}
      <div className="card" style={{ marginBottom: '1rem', borderLeft: '4px solid var(--color-warning)' }}>
        {activeTab === 'detail' ? (
          <>
            <strong>İşletme Detay Listesi.xls</strong>
            <p style={{ fontSize: '.85rem', color: 'var(--color-muted)', marginTop: '.35rem' }}>
              TC ve VKN numaraları tarayıcıda SHA-256 ile şifrelenerek saklanır.
              İsim, soyisim ve baba adı maskelenerek (örn: İ***m Ö***n) kaydedilir.
              Ham kişisel veriler sunucuya gönderilmez.
            </p>
            <p style={{ fontSize: '.85rem', color: 'var(--color-muted)', marginTop: '.25rem' }}>
              ⚠️ İşletme numarası <strong>TR{String(plateCode).padStart(2, '0')}</strong> ile başlamayan satırlar atlanır.
              Farklı ile ait satırlar yüklenmez.
            </p>
          </>
        ) : (
          <>
            <strong>⚠️ Hayvan Sayısı Listesi (Mahalle Bazlı Yükleme)</strong>
            <p style={{ fontSize: '.85rem', color: 'var(--color-muted)', marginTop: '.35rem' }}>
              Yükleme öncesinde <strong>yalnızca Excel'de yer alan mahallelerin</strong> hayvan
              sayıları sıfırlanır. Diğer mahalle ve ilçelerin verilerine kesinlikle dokunulmaz.
              Sayısı 0 olan işletmeler haritada görünmez.
            </p>
          </>
        )}
      </div>

      {/* Dropzone */}
      <div
        className={`upload-zone ${dragging ? 'upload-zone--drag-over' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => document.getElementById('file-input').click()}
        id="upload-dropzone"
      >
        <div className="upload-zone__icon">
          {file ? '📄' : '📂'}
        </div>
        <div className="upload-zone__text">
          {file ? file.name : 'Dosyayı sürükleyin veya tıklayın'}
        </div>
        <div className="upload-zone__hint">
          .xls, .xlsx desteklenir
        </div>
        <input
          id="file-input"
          type="file"
          accept=".xls,.xlsx"
          style={{ display: 'none' }}
          onChange={e => setFile(e.target.files[0])}
        />
      </div>

      {/* İlerleme */}
      {processing && (
        <div style={{ marginTop: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.82rem', color: 'var(--color-muted)', marginBottom: '.35rem' }}>
            <span>İşleniyor: {progress.current} / {progress.total}</span>
            <span>%{pct}</span>
          </div>
          <div className="progress">
            <div className="progress__bar" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {/* Hata */}
      {error && (
        <div style={{
          marginTop: '1rem', padding: '.75rem',
          background: 'rgba(231,76,60,.1)', border: '1px solid rgba(231,76,60,.3)',
          borderRadius: 'var(--radius-sm)', color: 'var(--color-danger)', fontSize: '.85rem'
        }}>
          ⚠️ {error}
        </div>
      )}

      {/* Yükle Butonu */}
      {!processing && (
        <button
          id="btn-start-upload"
          className="btn btn--primary btn--lg"
          style={{ width: '100%', marginTop: '1rem' }}
          onClick={handleUpload}
          disabled={!file}
        >
          🚀 Yüklemeyi Başlat
        </button>
      )}

      {/* Sonuç */}
      {results && (
        <div className="card" style={{ marginTop: '1rem', borderLeft: `4px solid ${results.failed > 0 ? 'var(--color-warning)' : 'var(--color-success)'}` }}>
          <h3 style={{ marginBottom: '.75rem' }}>
            {results.failed === 0 ? '✅ Yükleme Tamamlandı' : '⚠️ Kısmi Başarı'}
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '.5rem', textAlign: 'center' }}>
            <div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--color-success)' }}>
                {results.success}
              </div>
              <div style={{ fontSize: '.78rem', color: 'var(--color-muted)' }}>Başarılı</div>
            </div>
            <div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--color-danger)' }}>
                {results.failed}
              </div>
              <div style={{ fontSize: '.78rem', color: 'var(--color-muted)' }}>Hatalı</div>
            </div>
            <div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--color-warning)' }}>
                {results.skipped}
              </div>
              <div style={{ fontSize: '.78rem', color: 'var(--color-muted)' }}>Atlanan</div>
            </div>
            <div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{results.total}</div>
              <div style={{ fontSize: '.78rem', color: 'var(--color-muted)' }}>Toplam</div>
            </div>
          </div>

          {/* Hayvan yüklemesinde sıfırlanan mahalleler */}
          {results.type === 'animals' && results.neighbourhoods?.length > 0 && (
            <div style={{
              marginTop: '.75rem', padding: '.6rem', fontSize: '.82rem',
              background: 'var(--color-surface2)', borderRadius: 'var(--radius-sm)',
              color: 'var(--color-muted)'
            }}>
              <strong>Sıfırlanan mahalleler ({results.neighbourhoods.length} adet):</strong>{' '}
              {results.neighbourhoods.join(', ')}
            </div>
          )}
        </div>
      )}

      {/* Format hataları (atlanan satırlar) */}
      {parseErrors.length > 0 && (
        <div className="card" style={{ marginTop: '1rem', borderLeft: '4px solid var(--color-warning)' }}>
          <h4 style={{ marginBottom: '.5rem', color: 'var(--color-warning)' }}>
            ⚠️ Atlanan Satırlar ({parseErrors.length} adet)
          </h4>
          <div style={{ maxHeight: 200, overflowY: 'auto', fontSize: '.8rem', color: 'var(--color-muted)' }}>
            {parseErrors.map((e, i) => (
              <div key={i} style={{ padding: '.25rem 0', borderBottom: '1px solid var(--color-border)' }}>{e}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
