import { useAuth } from '../context/AuthContext'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const ROLE_LABELS = {
  super_admin:    { label: 'Süper Admin',    cls: 'badge--super'    },
  province_admin: { label: 'İl Yöneticisi',  cls: 'badge--admin'    },
  district_admin: { label: 'İlçe Yöneticisi',cls: 'badge--district' },
  field_staff:    { label: 'Saha Personeli', cls: 'badge--field'    },
}

export default function Navbar() {
  const { profile, signOut, canUploadExcel, isAdmin } = useAuth()
  const navigate = useNavigate()

  const roleInfo = ROLE_LABELS[profile?.role] || { label: 'Bilinmiyor', cls: 'badge--admin' }
  const initials = profile?.full_name
    ? profile.full_name.split(' ').map(n => n[0]).join('').slice(0,2).toUpperCase()
    : '?'

  async function handleSetPassive() {
    if (window.confirm("Hesabınızı pasife almak istediğinizden emin misiniz? (Bölge/İlçe değiştirmek için gereklidir).\n\nYeni bir il/ilçeye atanana kadar aktif kampanyaları göremezsiniz.")) {
      const { error } = await supabase.from('profiles').update({ is_active: false }).eq('id', profile.id);
      if (error) {
        alert("Hata oluştu: " + error.message);
      } else {
        alert(`Hesabınız başarıyla pasife alındı.\nYöneticinize e-posta adresinizi (${profile.email}) vererek sizi bölgeye katmasını isteyiniz.`);
        window.location.reload();
      }
    }
  }

  return (
    <nav className="navbar">
      <button className="navbar__brand" onClick={() => navigate('/')} style={{background:'none',border:'none',cursor:'pointer'}}>
        <img src="vetsis-logo.png" alt="Logo" style={{height: 24, width: 'auto', marginRight: '8px'}} /> <strong>VETSİS</strong>
        <span>Saha Kampanya Yönetimi</span>
      </button>

      <div style={{display:'flex', gap:'.5rem', alignItems:'center'}}>
        {canUploadExcel && (
          <button className="btn btn--ghost btn--sm" onClick={() => navigate('/excel-yukle')}>
            📊 Excel Yükle
          </button>
        )}
        {isAdmin && (
          <button className="btn btn--ghost btn--sm" onClick={() => navigate('/admin')}>
            ⚙️ Admin
          </button>
        )}
      </div>

      <div className="navbar__user">
        <div>
          <div style={{fontSize:'.8rem', fontWeight:600, textAlign:'right'}}>
            {profile?.full_name || profile?.email}
          </div>
          <div style={{display:'flex', justifyContent:'flex-end', marginTop:'.15rem'}}>
            <span className={`badge ${roleInfo.cls}`}>{roleInfo.label}</span>
          </div>
        </div>
        <div className="navbar__avatar">
          {profile?.avatar_url
            ? <img src={profile.avatar_url} alt="avatar" />
            : initials
          }
        </div>
        {profile?.role === 'field_staff' && profile?.is_active && (
          <button className="btn btn--sm btn--danger" onClick={handleSetPassive} title="Hesabı Pasife Al (Bölge Değiştir)" style={{ marginRight: '0.2rem' }}>
            ⏸️ Pasife Al
          </button>
        )}
        <button className="btn btn--ghost btn--sm" onClick={signOut} title="Çıkış Yap">
          🚪
        </button>
      </div>
    </nav>
  )
}
