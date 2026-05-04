import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

export default function DashboardPage() {
  const { profile, isAdmin, isDistrictAdmin, canUploadExcel } = useAuth()
  const navigate = useNavigate()
  const [campaigns, setCampaigns] = useState([])
  const [loading, setLoading]     = useState(true)
  const [showCreate, setShowCreate] = useState(false)

  useEffect(() => { fetchCampaigns() }, [])

  async function fetchCampaigns() {
    setLoading(true)
    const { data, error } = await supabase
      .from('campaigns')
      .select('*, districts(name, provinces(name))')
      .order('created_at', { ascending: false })

    if (!error) setCampaigns(data || [])
    setLoading(false)
  }

  const statusLabel = { active: '🟢 Aktif', completed: '✅ Tamamlandı', cancelled: '🔴 İptal' }

  return (
    <div>
      {/* Karşılama */}
      <div style={{marginBottom:'1.5rem'}}>
        <h1 style={{fontSize:'1.5rem', fontWeight:700}}>
          Hoş geldiniz, {profile?.full_name?.split(' ')[0]} 👋
        </h1>
        <p style={{color:'var(--color-muted)', marginTop:'.25rem'}}>
          {profile?.districts?.name
            ? `${profile.districts.name} İlçesi • ${profile.provinces?.name || ''}`
            : 'Tüm Türkiye'}
        </p>
      </div>

      {/* Aksiyon Butonları */}
      <div style={{display:'flex', gap:'.75rem', flexWrap:'wrap', marginBottom:'1.5rem'}}>
        {isDistrictAdmin && (
          <button className="btn btn--primary" onClick={() => setShowCreate(true)} id="btn-create-campaign">
            ➕ Yeni Kampanya Oluştur
          </button>
        )}
        {canUploadExcel && (
          <button className="btn btn--ghost" onClick={() => navigate('/excel-yukle')} id="btn-excel-upload">
            📊 Excel Yükle
          </button>
        )}
      </div>

      {/* Kampanya Listesi */}
      <h2 style={{fontSize:'1rem', marginBottom:'.75rem', color:'var(--color-muted)'}}>
        {isAdmin ? 'Tüm Kampanyalar' : 'Kampanyalarım'}
      </h2>

      {loading ? (
        <div className="loading-screen" style={{height:'200px'}}>
          <div className="spinner" />
        </div>
      ) : campaigns.length === 0 ? (
        <div className="card" style={{textAlign:'center', padding:'3rem', color:'var(--color-muted)'}}>
          <div style={{fontSize:'3rem', marginBottom:'1rem'}}>🗺️</div>
          <p>Henüz kampanya yok.</p>
          {isDistrictAdmin && (
            <button className="btn btn--primary" style={{marginTop:'1rem'}} onClick={() => setShowCreate(true)}>
              İlk Kampanyayı Oluştur
            </button>
          )}
        </div>
      ) : (
        <div className="dashboard-grid">
          {campaigns.map(c => (
            <div
              key={c.id}
              className="card"
              style={{cursor:'pointer'}}
              onClick={() => navigate(`/kampanya/${c.id}`)}
              id={`campaign-card-${c.id}`}
            >
              <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'.5rem'}}>
                <h3 style={{fontSize:'.95rem', fontWeight:600, flex:1}}>{c.name}</h3>
                <span style={{fontSize:'.75rem', whiteSpace:'nowrap', marginLeft:'.5rem'}}>
                  {statusLabel[c.status]}
                </span>
              </div>
              <p className="card__meta">
                📍 {c.districts?.name} — {c.districts?.provinces?.name}
              </p>
              {c.operation_date && (
                <p className="card__meta">
                  📅 {new Date(c.operation_date).toLocaleDateString('tr-TR')}
                </p>
              )}
              <div style={{
                marginTop:'.75rem',
                padding:'.5rem .75rem',
                background:'rgba(46,134,222,.08)',
                borderRadius:'var(--radius-sm)',
                fontSize:'.82rem',
                color:'var(--color-muted)'
              }}>
                Haritaya git →
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Yeni Kampanya Modal */}
      {showCreate && (
        <CreateCampaignModal
          profile={profile}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); fetchCampaigns() }}
        />
      )}
    </div>
  )
}

function CreateCampaignModal({ profile, onClose, onCreated }) {
  const [name, setName]               = useState('')
  const [description, setDescription] = useState('')
  const [species, setSpecies]         = useState(['sigir'])
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState('')

  const speciesList = [
    { value: 'sigir', label: '🐄 Sığır' },
    { value: 'manda', label: '🐃 Manda' },
    { value: 'koyun', label: '🐑 Koyun' },
    { value: 'keci',  label: '🐐 Keçi'  },
  ]

  function toggleSpecies(val) {
    setSpecies(prev =>
      prev.includes(val) ? prev.filter(s => s !== val) : [...prev, val]
    )
  }

  async function handleCreate() {
    if (!name.trim()) { setError('Kampanya adı zorunludur'); return }
    if (species.length === 0) { setError('En az bir hayvan türü seçin'); return }
    if (!profile?.district_id) { setError('İlçe bilgisi bulunamadı'); return }

    setSaving(true)
    setError('')
    try {
      const { data: campaign, error: campErr } = await supabase
        .from('campaigns')
        .insert({
          name: name.trim(),
          description: description.trim() || null,
          district_id: profile.district_id,
          created_by: profile.id,
          operation_date: new Date().toISOString().slice(0, 10)
        })
        .select()
        .single()

      if (campErr) throw campErr

      // Hayvan türlerini ekle
      await supabase.from('campaign_species').insert(
        species.map(s => ({ campaign_id: campaign.id, species: s }))
      )

      onCreated()
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal__header">
          <span>Yeni Kampanya Oluştur</span>
          <button className="btn btn--ghost btn--sm" onClick={onClose}>✕</button>
        </div>
        <div className="modal__body">
          <div className="form-group">
            <label className="form-label">Kampanya Adı *</label>
            <input
              id="input-campaign-name"
              className="form-control"
              placeholder="Örn: 2026 İlkbahar Şap Aşısı"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Açıklama</label>
            <textarea
              className="form-control"
              rows={3}
              style={{resize:'vertical'}}
              placeholder="(İsteğe bağlı)"
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Aşılanacak Hayvan Türleri *</label>
            <div style={{display:'flex', gap:'.5rem', flexWrap:'wrap', marginTop:'.3rem'}}>
              {speciesList.map(s => (
                <button
                  key={s.value}
                  className={`btn ${species.includes(s.value) ? 'btn--primary' : 'btn--ghost'}`}
                  onClick={() => toggleSpecies(s.value)}
                  type="button"
                  id={`species-${s.value}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          {error && (
            <div style={{color:'var(--color-danger)', fontSize:'.85rem', padding:'.5rem', background:'rgba(231,76,60,.1)', borderRadius:'var(--radius-sm)'}}>
              ⚠️ {error}
            </div>
          )}
        </div>
        <div className="modal__footer">
          <button className="btn btn--ghost" onClick={onClose}>İptal</button>
          <button className="btn btn--primary" onClick={handleCreate} disabled={saving} id="btn-save-campaign">
            {saving ? '⏳ Kaydediliyor...' : '✅ Kampanya Oluştur'}
          </button>
        </div>
      </div>
    </div>
  )
}
