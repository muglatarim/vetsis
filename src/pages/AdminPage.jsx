import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

export default function AdminPage() {
  const { profile, isAdmin }  = useAuth()
  const [users, setUsers]     = useState([])
  const [provinces, setProvinces] = useState([])
  const [districts, setDistricts] = useState([])
  
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(null)
  
  const [searchTerm, setSearchTerm] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteDistrict, setInviteDistrict] = useState('')
  const [inviting, setInviting] = useState(false)

  const roles = [
    { value: 'super_admin',    label: 'Süper Admin'    },
    { value: 'province_admin', label: 'İl Yöneticisi'  },
    { value: 'district_admin', label: 'İlçe Yöneticisi'},
    { value: 'field_staff',    label: 'Saha Personeli' },
  ]

  useEffect(() => {
    if (isAdmin) {
      fetchUsers()
      fetchPlaces()
    }
  }, [isAdmin])

  async function fetchUsers() {
    setLoading(true)
    const { data } = await supabase
      .from('profiles')
      .select('*, provinces(name), districts(name)')
      .order('created_at', { ascending: false })
    setUsers(data || [])
    setLoading(false)
  }

  async function fetchPlaces() {
    const { data: provs } = await supabase.from('provinces').select('*').order('name')
    if (provs) setProvinces(provs)

    const { data: dists } = await supabase.from('districts').select('*').order('name')
    if (dists) setDistricts(dists)
  }

  async function updateRole(userId, newRole) {
    setSaving(userId)
    await supabase.from('profiles').update({ role: newRole }).eq('id', userId)
    setSaving(null)
    fetchUsers()
  }

  async function updateProvince(userId, newProvinceId) {
    setSaving(userId)
    const val = newProvinceId !== '' ? parseInt(newProvinceId, 10) : null
    await supabase.from('profiles').update({ province_id: val, district_id: null }).eq('id', userId)
    setSaving(null)
    fetchUsers()
  }

  async function updateDistrict(userId, newDistrictId) {
    setSaving(userId)
    const val = newDistrictId !== '' ? parseInt(newDistrictId, 10) : null
    await supabase.from('profiles').update({ district_id: val }).eq('id', userId)
    setSaving(null)
    fetchUsers()
  }

  async function toggleActive(userId, current) {
    setSaving(userId)
    if (profile?.role === 'super_admin') {
      await supabase.from('profiles').update({ is_active: !current }).eq('id', userId)
    } else {
      const { data, error } = await supabase.rpc('toggle_manager_user_status', {
        p_target_user_id: userId,
        p_new_status: !current
      })
      if (error) {
        alert("Durum güncellenemedi: " + error.message)
      } else if (data && !data.success) {
        alert(data.message)
      }
    }
    setSaving(null)
    fetchUsers()
  }

  async function handleInvite() {
    if (!inviteEmail.trim()) {
      alert("Lütfen bir e-posta adresi girin.");
      return;
    }
    setInviting(true);
    let p_district_id = null;
    if (profile?.role === 'province_admin' || profile?.role === 'super_admin') {
      if (!inviteDistrict) {
         alert("Lütfen atama yapılacak ilçeyi seçin.");
         setInviting(false);
         return;
      }
      p_district_id = parseInt(inviteDistrict, 10);
    }

    const { data, error } = await supabase.rpc('assign_passive_user_by_email', { 
      p_email: inviteEmail.trim(),
      p_district_id 
    });

    setInviting(false);
    if (error) {
      alert("Bir hata oluştu: " + error.message);
    } else if (data && data.success) {
      alert(data.message);
      setInviteEmail('');
      setInviteDistrict('');
      setSearchTerm(''); // listeyi tazelemişken aramayı sıfırla ki eklenen adam görünsün
      fetchUsers();
    } else {
      alert(data?.message || "Beklenmeyen bir hata oluştu.");
    }
  }

  if (!isAdmin) {
    return (
      <div className="card" style={{textAlign:'center', padding:'3rem', color:'var(--color-muted)'}}>
        ⛔ Bu sayfaya erişim yetkiniz yok.
      </div>
    )
  }

  // Arama ve yetki filtreleme
  const filteredUsers = users.filter(u => {
    // İl yöneticisi kısıtlaması: sadece kendi ilindekileri veya ili atanmamışları görebilir
    if (profile?.role === 'province_admin') {
      if (u.province_id !== null && u.province_id !== profile.province_id) return false;
    }
    
    if (!searchTerm) return true
    const s = searchTerm.toLowerCase()
    const nameMatch = u.full_name?.toLowerCase().includes(s)
    const emailMatch = u.email?.toLowerCase().includes(s)
    return nameMatch || emailMatch
  })

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
        <h1 style={{fontSize:'1.4rem', fontWeight:700, margin: 0}}>
          ⚙️ Kullanıcı Yönetimi
        </h1>
        
        <input 
          type="text" 
          placeholder="İsim veya e-posta ile ara..." 
          className="form-control"
          style={{ maxWidth: '300px' }}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      {/* PERSONEL DAVET/EKLE BÖLÜMÜ */}
      {profile?.role !== 'field_staff' && (
        <div className="card" style={{ marginBottom: '1.5rem', padding: '1rem', border: '1px solid var(--color-border)' }}>
          <h3 style={{ marginTop: 0, fontSize: '1.1rem', display: 'flex', alignItems: 'center', gap: '.5rem' }}>
            <span style={{fontSize: '1.3rem'}}>✉️</span> Personel Davet / Transfer Et
          </h3>
          <p style={{ fontSize: '0.85rem', color: 'var(--color-muted)', marginBottom: '1rem', marginTop: '0.25rem' }}>
            {profile?.role === 'super_admin' ? 'E-posta adresi ile pasif bir personeli direkt seçilen ilçeye aktarabilirsiniz.' : 'Başka bir ilçeden/ilden sizin bölgenize geçmek isteyen personeller HESAPLARINI PASİFE ALMALI ve ardından e-posta adreslerini size vermelidir.'}
          </p>
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            <input 
              type="email" 
              placeholder="Personelin E-posta Adresi (Tam Eşleşme)" 
              className="form-control"
              value={inviteEmail}
              onChange={e => setInviteEmail(e.target.value)}
              style={{ flex: '1', minWidth: '200px' }}
            />
            
            {(profile?.role === 'province_admin' || profile?.role === 'super_admin') && (
              <select 
                className="form-control"
                value={inviteDistrict}
                onChange={e => setInviteDistrict(e.target.value)}
                style={{ width: 'auto', minWidth: '150px' }}
              >
                <option value="">-- Atanacak İlçe --</option>
                {districts
                  .filter(d => profile?.role === 'super_admin' ? true : d.province_id === profile?.province_id)
                  .map(d => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            )}

            <button 
              className="btn btn--primary" 
              onClick={handleInvite}
              disabled={inviting || !inviteEmail}
            >
              {inviting ? '⏳ Ekleniyor...' : 'Sorgula ve Ekle / Davet Et'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="loading-screen" style={{height:200}}>
          <div className="spinner" />
        </div>
      ) : (
        <div style={{overflowX:'auto'}}>
          <table style={{
            width:'100%', borderCollapse:'collapse',
            background:'var(--color-surface)', borderRadius:'var(--radius-md)',
            overflow:'hidden'
          }}>
            <thead>
              <tr style={{background:'var(--color-surface2)'}}>
                {['Ad Soyad','E-posta','Rol','İl','İlçe','Durum','İşlem'].map(h => (
                  <th key={h} style={{
                    padding:'.75rem 1rem', textAlign:'left',
                    fontSize:'.8rem', color:'var(--color-muted)', fontWeight:600
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((u, i) => {
                // Sadece Süper Admin rol değişikliği veya il/ilçe taşıması yapabilir (liste üzerinden).
                // Diğer yöneticiler sadece davet formunu kullanmalı ve eklediklerinin aktif/pasifliğini değiştirebilir.
                const isSuperAdmin = profile?.role === 'super_admin'
                const disableSelects = !isSuperAdmin || saving === u.id;
                
                // İl yöneticisi kendi tablosunda başkasını değiştiremesin (zaten disableSelects ile kapanıyor ama toggle için ek kural)
                const isTargetSuperAdmin = u.role === 'super_admin'
                const preventToggle = (!isSuperAdmin && isTargetSuperAdmin) || saving === u.id

                // Bu kullanıcının seçili ilindeki ilçeler
                const userDistricts = districts.filter(d => d.province_id === u.province_id)

                return (
                  <tr key={u.id} style={{
                    borderTop:'1px solid var(--color-border)',
                    opacity: u.is_active ? 1 : .5
                  }}>
                    <td style={{padding:'.75rem 1rem', fontSize:'.88rem'}}>
                      <div style={{fontWeight:500}}>{u.full_name || '—'}</div>
                    </td>
                    <td style={{padding:'.75rem 1rem', fontSize:'.82rem', color:'var(--color-muted)'}}>
                      {u.email}
                    </td>
                    
                    {/* Rol Seçimi */}
                    <td style={{padding:'.75rem 1rem'}}>
                      <select
                        className="form-control"
                        style={{width:'auto', fontSize:'.82rem', padding:'.3rem .5rem'}}
                        value={u.role}
                        disabled={u.id === profile?.id || disableSelects}
                        onChange={e => updateRole(u.id, e.target.value)}
                        id={`role-select-${u.id}`}
                      >
                        {roles.map(r => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </select>
                    </td>

                    {/* İl Seçimi */}
                    <td style={{padding:'.75rem 1rem', fontSize:'.82rem'}}>
                      <select
                        className="form-control"
                        style={{width:'auto', fontSize:'.82rem', padding:'.3rem .5rem', maxWidth: '120px'}}
                        value={u.province_id || ''}
                        disabled={disableSelects}
                        onChange={e => updateProvince(u.id, e.target.value)}
                        id={`prov-select-${u.id}`}
                      >
                        <option value="">-- Tüm Türkiye --</option>
                        {provinces.map(p => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </td>

                    {/* İlçe Seçimi */}
                    <td style={{padding:'.75rem 1rem', fontSize:'.82rem'}}>
                      <select
                        className="form-control"
                        style={{width:'auto', fontSize:'.82rem', padding:'.3rem .5rem', maxWidth: '120px'}}
                        value={u.district_id || ''}
                        disabled={disableSelects || !u.province_id}
                        onChange={e => updateDistrict(u.id, e.target.value)}
                        id={`dist-select-${u.id}`}
                      >
                        <option value="">-- Tüm İlçe --</option>
                        {userDistricts.map(d => (
                          <option key={d.id} value={d.id}>{d.name}</option>
                        ))}
                      </select>
                    </td>

                    <td style={{padding:'.75rem 1rem'}}>
                      <span className={`badge ${u.is_active ? 'badge--field' : 'badge--super'}`}>
                        {u.is_active ? 'Aktif' : 'Pasif'}
                      </span>
                    </td>

                    <td style={{padding:'.75rem 1rem'}}>
                      {u.id !== profile?.id && !isTargetSuperAdmin && (
                        <button
                          className={`btn btn--sm ${u.is_active ? 'btn--danger' : 'btn--success'}`}
                          disabled={preventToggle}
                          onClick={() => toggleActive(u.id, u.is_active)}
                          id={`toggle-active-${u.id}`}
                        >
                          {saving === u.id ? '⏳' : u.is_active ? 'Pasife Al' : 'Aktif Yap'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {filteredUsers.length === 0 && (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-muted)' }}>
              Arama kriterlerine uyan kullanıcı bulunamadı.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
