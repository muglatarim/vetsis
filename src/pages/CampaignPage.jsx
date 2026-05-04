import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { MapContainer, TileLayer, GeoJSON, useMap, Marker, Popup, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import { supabase, createVisitChannel } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { generateTempId, formatPartialEnterpriseId } from '../utils/crypto'

// ─── Hayvan türü renk/ikon sistemi ──────────────────────────────────────────
const SPECIES_COLORS = {
  sigir: '#3498db',
  manda: '#9b59b6',
  koyun: '#f39c12',
  keci: '#27ae60',
}
const SPECIES_EMOJI = { sigir: '🐄', manda: '🐃', koyun: '🐑', keci: '🐐' }

const STATUS_COLORS = {
  pending: '#636e72',
  detected: '#f39c12',
  visited: '#27ae60',
}

// Özel div icon oluşturucu
function createHerdIcon(status, dominant) {
  const bg = STATUS_COLORS[status] || STATUS_COLORS.pending
  const emoji = SPECIES_EMOJI[dominant] || '📍'
  const tick = status === 'visited' ? '<span style="position:absolute;bottom:0;right:-2px;font-size:10px">✓</span>' : ''
  return L.divIcon({
    className: '',
    html: `
      <div style="
        position:relative;
        background:${bg};
        width:34px;height:34px;
        border-radius:50% 50% 50% 0;
        transform:rotate(-45deg);
        border:2px solid rgba(255,255,255,0.5);
        box-shadow:0 2px 6px rgba(0,0,0,0.4);
        display:flex;align-items:center;justify-content:center;
        transition:background .3s;
      ">
        <span style="transform:rotate(45deg);font-size:13px;line-height:1">${emoji}</span>
        ${tick}
      </div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 34],
    popupAnchor: [0, -36],
  })
}

// ─── GPS Takip Hook ─────────────────────────────────────────────────────────
function useGPS(active, onPosition) {
  const watchRef = useRef(null)

  useEffect(() => {
    if (!active) {
      if (watchRef.current) navigator.geolocation.clearWatch(watchRef.current)
      return
    }
    if ('geolocation' in navigator) {
      watchRef.current = navigator.geolocation.watchPosition(
        pos => onPosition(pos.coords.latitude, pos.coords.longitude),
        err => console.warn('GPS hatası:', err),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
      )
    }
    return () => { if (watchRef.current) navigator.geolocation.clearWatch(watchRef.current) }
  }, [active])
}

// ─── Harita merkezi güncelleme bileşeni ─────────────────────────────────────
function MapCenter({ center }) {
  const map = useMap()
  useEffect(() => { if (center) map.flyTo(center, map.getZoom()) }, [center])
  return null
}

// ─── Harita Tıklama Yöneticisi ───────────────────────────────────────────────
function MapClickHandler({ addMode, setClicked, setAddMode }) {
  const map = useMapEvents({
    click(e) {
      if (!addMode) return
      setClicked([e.latlng.lat, e.latlng.lng])
      setAddMode(false)
    }
  })

  useEffect(() => {
    if (addMode) {
      map.getContainer().style.cursor = 'crosshair'
    } else {
      map.getContainer().style.cursor = ''
    }
  }, [addMode, map])

  return null
}

// ─── Ana Bileşen ─────────────────────────────────────────────────────────────
export default function CampaignPage() {
  const { id: campaignId } = useParams()
  const navigate = useNavigate()
  const { profile } = useAuth()

  const [campaign, setCampaign] = useState(null)
  const [herds, setHerds] = useState([])
  const [species, setSpecies] = useState([])      // Kampanya türleri
  const [geoJson, setGeoJson] = useState(null)    // Mahalle sınırları
  const [districtNeighbourhoods, setDistrictNeighbourhoods] = useState([]) // YENİ
  const [loading, setLoading] = useState(true)

  const [activeMission, setActiveMission] = useState(null)

  const [selectedNeighbourhood, setSelectedNeighbourhood] = useState('')

  const [gpsActive, setGpsActive] = useState(false)
  const [myPos, setMyPos] = useState(null)    // [lat, lng]
  const [nearbyHerds, setNearby] = useState([])      // 20m içindekiler

  const [selectedHerd, setSelected] = useState(null)   // Popup
  const [addMode, setAddMode] = useState(false)   // Haritaya tıkla → koordinat al
  const [clickedCoord, setClicked] = useState(null)

  const [showStartMission, setShowStartMission] = useState(false) // Görev Başlat modal
  const [showFinish, setShowFinish] = useState(false)   // Görevi Bitir modal
  const [showInvite, setShowInvite] = useState(false)   // Personel Davet modal
  const [toast, setToast] = useState(null)

  const mapRef = useRef(null)

  // ── Veri yükleme ──────────────────────────────────────────────────────────
  useEffect(() => {
    fetchCampaign()
  }, [campaignId])

  async function fetchCampaign() {
    setLoading(true)
    const { data: camp } = await supabase
      .from('campaigns')
      .select('*, districts(name, province_id, provinces(name, id))')
      .eq('id', campaignId)
      .single()
    if (!camp) { navigate('/'); return }

    setCampaign(camp)

    await fetchActiveMission()

    const { data: sp } = await supabase
      .from('campaign_species')
      .select('species')
      .eq('campaign_id', campaignId)
    const spList = sp?.map(s => s.species) || []
    setSpecies(spList)

    // GeoJSON yükle (Sadece ilin dosyasını indir, ilçe sınırları içinde olacak)
    const il = camp.districts?.provinces?.name
    if (il) loadGeoJson(il, camp.districts.name)

    // İlçeye ait tüm mahalleleri çek (filtreleme için)
    const { data: nData } = await supabase
      .from('neighbourhoods')
      .select('id, name')
      .eq('district_id', camp.district_id)
      .order('name')
    setDistrictNeighbourhoods(nData || [])

    await fetchHerds(spList)
    setLoading(false)
  }

  async function fetchActiveMission() {
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await supabase
      .from('daily_missions')
      .select('*')
      .eq('user_id', profile?.id)
      .eq('campaign_id', campaignId)
      .eq('operation_date', today)
      .is('finished_at', null)
      .maybeSingle()

    setActiveMission(data)
    if (data && data.neighbourhood_id) {
      setSelectedNeighbourhood(data.neighbourhood_id.toString())
    }
  }

  const [rpcError, setRpcError] = useState(null)

  async function fetchHerds(sp = species) {
    if (!sp.length) {
      console.log("No species selected, aborting fetchHerds");
      return;
    }
    const { data, error } = await supabase.rpc('get_campaign_herds', {
      p_campaign_id: campaignId,
      p_species: sp
    })
    console.log("fetchHerds response:", data, error);
    if (!error) {
      setHerds(data || [])
      setRpcError(null)
    } else {
      console.error("get_campaign_herds RPC ERROR:", error);
      setRpcError(error.message || JSON.stringify(error))
    }
  }

  async function loadGeoJson(ilName, ilceName) {
    try {
      // Türkçe il isimlerini normalleştir (örn: MUĞLA -> Muğla)
      const normalized = ilName.charAt(0).toLocaleUpperCase('tr-TR') + ilName.slice(1).toLocaleLowerCase('tr-TR')
      const baseUrl = import.meta.env.BASE_URL;
      const res = await fetch(`${baseUrl}maps/${encodeURIComponent(normalized)}.geojson`)
      if (res.ok) {
        const rawJson = await res.json()

        // GeoJSON içinden sadece bu ilçenin mahallelerini filtrelemeyi deneyelim
        // (Şekil dosyalarında genellikle NAME_2 ilçe, NAME_3/TEXT mahalle vs. olur. Veya ilce/mahalle özellikleridir)
        if (rawJson.features) {
          const ilceUpper = ilceName ? ilceName.toUpperCase() : ''
          const distFeatures = rawJson.features.filter(f => {
            // Prop'lar değişkendir, en yüksek ihtimal olanları tarıyoruz
            const props = f.properties || {};
            const vals = Object.values(props).map(v => typeof v === 'string' ? v.toUpperCase() : '');
            return vals.some(v => v.includes(ilceUpper) || v === ilceUpper);
          })

          if (distFeatures.length > 0) {
            console.log("Found District features: ", distFeatures.length);
            setGeoJson({ ...rawJson, features: distFeatures })
          } else {
            console.log("No specific distFeatures found. Rendering whole province.");
            setGeoJson(rawJson)
          }
        } else {
          setGeoJson(rawJson)
        }
      } else {
        console.warn('GeoJSON request failed:', res.status);
      }
    } catch (e) {
      console.warn('GeoJSON yüklenemedi:', e)
    }
  }

  // ── Realtime Aboneliği ────────────────────────────────────────────────────
  useEffect(() => {
    const channel = createVisitChannel(campaignId, (payload) => {
      setHerds(prev => prev.map(h => {
        if (h.herd_id === payload.new?.herd_id) {
          return { ...h, visit_status: payload.new.status }
        }
        return h
      }))
    })
    return () => supabase.removeChannel(channel)
  }, [campaignId])

  // ── GPS ───────────────────────────────────────────────────────────────────
  useGPS(gpsActive, async (lat, lng) => {
    setMyPos([lat, lng])
    if (!activeMission) return; // Görev başlatılmadıysa tespit yapma

    const { data } = await supabase.rpc('get_nearby_herds', {
      p_campaign_id: campaignId,
      p_lat: lat,
      p_lng: lng,
      p_radius_m: 20
    })
    if (data?.length) {
      setNearby(data)
      for (const nh of data) {
        if (nh.visit_status === 'pending') {
          await markDetected(nh.herd_id)
        }
      }
    }
  })

  async function markDetected(herdId) {
    const today = new Date().toISOString().slice(0, 10)
    const opDate = campaign?.operation_date || today

    // Önce var mı diye kontrol et (UNIQUE constraint yoksa upsert patlar)
    const { data: existing } = await supabase
      .from('visit_logs')
      .select('id')
      .eq('campaign_id', campaignId)
      .eq('herd_id', herdId)
      .single()

    if (existing) {
      // Sadece güncelle (Eğer status zaten visited değilse)
      await supabase.from('visit_logs').update({
        user_id: profile.id, // Son dokunan kullanıcı
        status: 'detected',
        detected_at: new Date().toISOString()
      }).eq('id', existing.id).neq('status', 'visited') // visited olanı bozma
    } else {
      // Yeni log at
      await supabase.from('visit_logs').insert({
        campaign_id: campaignId,
        herd_id: herdId,
        user_id: profile.id,
        status: 'detected',
        detected_at: new Date().toISOString(),
        operation_date: opDate
      })
    }

    setHerds(prev => prev.map(h =>
      (h.herd_id === herdId && h.visit_status !== 'visited') ? { ...h, visit_status: 'detected' } : h
    ))
    // Popup'taki surüyü de güncelle
    setSelected(prev => prev?.herd_id === herdId ? { ...prev, visit_status: 'detected' } : prev)
  }

  async function markVisited(herdId) {
    const today = new Date().toISOString().slice(0, 10)
    const opDate = campaign?.operation_date || today

    try {
      // Önce log var mı kontrol et
      const { data: existing, error: selErr } = await supabase
        .from('visit_logs')
        .select('id')
        .eq('campaign_id', campaignId)
        .eq('herd_id', herdId)
        .maybeSingle()

      if (selErr) {
        alert("Sorgu hatası: " + selErr.message);
        return;
      }

      let error = null;

      if (existing) {
        const { data: updatedData, error: updErr } = await supabase.from('visit_logs').update({
          user_id: profile.id,
          status: 'visited',
          visited_at: new Date().toISOString()
        }).eq('id', existing.id).select();

        if (!updErr && (!updatedData || updatedData.length === 0)) {
          error = { message: "Yetkisiz işlem! Bu ziyareti güncelleme yetkiniz yok (İlk ziyareti farklı bir personel eklemiş olabilir veya RLS engeli)." };
        } else {
          error = updErr;
        }
      } else {
        const { error: insErr } = await supabase.from('visit_logs').insert({
          campaign_id: campaignId,
          herd_id: herdId,
          user_id: profile.id,
          status: 'visited',
          visited_at: new Date().toISOString(),
          operation_date: opDate
        });
        error = insErr;
      }

      if (!error) {
        setHerds(prev => prev.map(h =>
          h.herd_id === herdId ? { ...h, visit_status: 'visited' } : h
        ))
        // Popup açıksa içindeki veriyi güncelle (kapatılmıyor)
        setSelected(prev => prev?.herd_id === herdId ? { ...prev, visit_status: 'visited' } : prev)
        showToast('✅ Ziyaret onaylandı', 'success')
      } else {
        alert('❌ Hata: ' + error.message) // Toast arkada kalabilir diye alert kullanıyoruz
      }
    } catch (err) {
      alert("Beklenmeyen Hata: " + err.message);
    }
  }

  function showToast(msg, type = 'info') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  async function revertVisit(herdId) {
    try {
      const { error } = await supabase
        .from('visit_logs')
        .update({ status: 'pending' })
        .eq('campaign_id', campaignId)
        .eq('herd_id', herdId)
        .eq('user_id', profile.id)   // Sadece kendi kaydcını geri alabilir

      if (error) {
        alert('❌ Geri alma hatası: ' + error.message)
        return
      }

      setHerds(prev => prev.map(h =>
        h.herd_id === herdId ? { ...h, visit_status: 'pending' } : h
      ))
      setSelected(prev => prev?.herd_id === herdId ? { ...prev, visit_status: 'pending' } : prev)
      showToast('↩️ Ziyaret geri alındı', 'info')
    } catch (err) {
      alert('Beklenmeyen hata: ' + err.message)
    }
  }

  function geoJsonStyle(feature) {
    let isMatched = false;

    // Eğer bir mahalle seçiliyse ve GeoJSON'un properties'i varsa kontrol et
    if (selectedNeighbourhood && feature.properties) {
      // selectedNeighbourhood şu an DB ID'sini tutuyor. İsmini bulalım:
      const selectedObj = districtNeighbourhoods.find(n => n.id.toString() === selectedNeighbourhood.toString());
      if (selectedObj) {
        // "TURGUT MAH." veya "BENCİK KÖYÜ" -> "TURGUT" / "BENCİK"
        const searchTarget = selectedObj.name.replace(/ (MAH\.|MAHALLESİ|KÖYÜ|KÖY)/i, '').trim().toLocaleUpperCase('tr-TR');

        const propVals = Object.values(feature.properties).map(v => typeof v === 'string' ? v.toLocaleUpperCase('tr-TR') : '');
        isMatched = propVals.some(v => v === searchTarget || v.includes(searchTarget));
      }
    }

    if (selectedNeighbourhood && isMatched) {
      return {
        color: '#e74c3c',
        weight: 3,
        opacity: 1,
        fillColor: '#e74c3c',
        fillOpacity: .3,
      }
    }

    return {
      color: '#f1c40f', // Çok görünür SARI sınır
      weight: 2,
      opacity: .9,
      fillColor: '#0d1b2a',
      fillOpacity: selectedNeighbourhood ? .05 : .2,
    }
  }

  // Mahalle filtreleme (ID üzerinden)
  const filteredHerds = selectedNeighbourhood
    ? herds.filter(h => h.neighbourhood_id?.toString() === selectedNeighbourhood.toString())
    : herds;

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <span>Kampanya yükleniyor...</span>
      </div>
    )
  }

  const baseCountList = selectedNeighbourhood ? filteredHerds : herds;
  const pendingCount = baseCountList.filter(h => h.visit_status === 'pending').length
  const detectedCount = baseCountList.filter(h => h.visit_status === 'detected').length
  const visitedCount = baseCountList.filter(h => h.visit_status === 'visited').length
  const totalCount = baseCountList.length
  const pct = totalCount > 0 ? Math.round((visitedCount / totalCount) * 100) : 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 60px)', overflow: 'hidden' }}>
      {/* Üst Bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '1rem',
        padding: '.6rem 1rem',
        background: 'var(--color-surface)',
        borderBottom: '1px solid var(--color-border)',
        flexWrap: 'wrap'
      }}>
        <button className="btn btn--ghost btn--sm" onClick={() => navigate('/')}>← Geri</button>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '.5rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontWeight: 600, fontSize: '.95rem' }}>{campaign?.name}</span>
            <span style={{ color: 'var(--color-muted)', fontSize: '.82rem' }}>
              {campaign?.districts?.name}
            </span>
          </div>

          {/* Mahalle Filtresi */}
          <select
            className="form-control"
            style={{ padding: '.3rem .5rem', fontSize: '.85rem', width: '150px' }}
            value={selectedNeighbourhood}
            onChange={(e) => setSelectedNeighbourhood(e.target.value)}
            disabled={activeMission !== null} // Aktif görevdeyken değiştirilemez
          >
            <option value="">-- Tüm Mahalleler --</option>
            {districtNeighbourhoods.map(n => (
              <option key={n.id} value={n.id}>{n.name}</option>
            ))}
          </select>
        </div>

        {/* İstatistikler */}
        <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', fontSize: '.8rem' }}>
          <span style={{ color: STATUS_COLORS.pending, fontWeight: 'bold' }} title="Bekleyen">⚪ {pendingCount}</span>
          <span style={{ color: STATUS_COLORS.detected, fontWeight: 'bold' }} title="Yakında">🟡 {detectedCount}</span>
          <span style={{ color: STATUS_COLORS.visited, fontWeight: 'bold' }} title="Ziyaret Edildi">🟢 {visitedCount}</span>
          <span style={{ color: 'var(--color-muted)', fontWeight: 600 }}>| %{pct}</span>
        </div>

        {/* Aksiyon Butonları */}
        {['super_admin', 'province_admin', 'district_admin'].includes(profile?.role) && (
          <button
            className="btn btn--primary btn--sm"
            onClick={() => setShowInvite(true)}
          >
            👥 Personel Davet
          </button>
        )}
        <button
          id="btn-gps-toggle"
          className={`btn btn--sm ${gpsActive ? 'btn--success' : 'btn--ghost'}`}
          onClick={() => setGpsActive(v => !v)}
        >
          {gpsActive ? '📡 GPS Açık' : '📡 GPS'}
        </button>
        <button
          id="btn-add-herd"
          className={`btn btn--sm ${addMode ? 'btn--warning' : 'btn--ghost'}`}
          onClick={() => setAddMode(v => !v)}
          style={addMode ? { color: '#fff', background: 'var(--color-warning)' } : {}}
          disabled={!activeMission}
        >
          {addMode ? '↩ İptal' : '➕ Sürü Ekle'}
        </button>

        {!activeMission ? (
          <button
            className="btn btn--success btn--sm"
            onClick={() => setShowStartMission(true)}
          >
            🚀 Görev Başlat
          </button>
        ) : (
          <button
            id="btn-finish-day"
            className="btn btn--primary btn--sm"
            onClick={() => setShowFinish(true)}
          >
            🏁 Görevi Bitir
          </button>
        )}
      </div>

      <div style={{
        background: '#2d3436', color: '#00b894', padding: '10px', fontSize: '12px',
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px', zIndex: 9999
      }}>
        <div><strong>Kampanya ID:</strong> {campaignId}</div>
        <div><strong>İlçe:</strong> {campaign?.districts?.name}</div>
        <div><strong>Mahalle Sayısı:</strong> {districtNeighbourhoods.length}</div>
        <div><strong>Sürü (Veriler):</strong> {herds.length}</div>
        <div><strong>Seçili Türler:</strong> {species.join(', ') || 'YOK!'}</div>
        <div><strong>GeoJSON:</strong> {geoJson ? 'YÜKLENDİ' : 'YÜKLENMEDİ'}</div>
        <div style={{ gridColumn: '1 / -1', color: 'var(--color-danger)' }}>
          <strong>RPC Hatası:</strong> {rpcError || 'Yok'}
        </div>
      </div>

      {/* İlerleme Çubuğu */}
      <div className="progress" style={{ borderRadius: 0, height: 6 }}>
        <div className="progress__bar" style={{ width: `${pct}%` }} />
      </div>

      {/* Harita */}
      <div style={{ flex: 1, position: 'relative' }}>
        {addMode && (
          <div style={{
            position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(243,156,18,.9)', color: '#fff',
            padding: '.5rem 1.25rem', borderRadius: 'var(--radius-md)',
            fontSize: '.85rem', fontWeight: 600, zIndex: 1000, pointerEvents: 'none'
          }}>
            📍 Konumu belirlemek için haritaya tıklayın
          </div>
        )}

        <MapContainer
          center={[37.2, 28.3]}
          zoom={11}
          style={{ height: '100%', width: '100%', background: '#1a2e48' }}
          ref={mapRef}
        >
          <MapClickHandler addMode={addMode} setClicked={setClicked} setAddMode={setAddMode} />

          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='© <a href="https://openstreetmap.org">OSM</a>'
          />

          {/* Mahalle sınırları */}
          {geoJson && (
            <GeoJSON
              data={geoJson}
              style={geoJsonStyle}
              key={selectedNeighbourhood || 'all'}
            />
          )}

          {/* GPS konumum */}
          {myPos && (
            <MapCenter center={myPos} />
          )}

          {/* Sürü pinleri */}
          {filteredHerds.map(h => {
            if (!h.lat || !h.lng) return null
            return (
              <HerdMarker
                key={h.herd_id}
                herd={h}
                onSelect={setSelected}
              />
            )
          })}
        </MapContainer>
      </div>

      {/* Sürü Popup */}
      {selectedHerd && (
        <HerdPopup
          herd={selectedHerd}
          campaignId={campaignId}
          profile={profile}
          onClose={() => setSelected(null)}
          onVisited={() => markVisited(selectedHerd.herd_id)}
          onReverted={() => revertVisit(selectedHerd.herd_id)}
          onRefresh={fetchHerds}
          showToast={showToast}
        />
      )}

      {/* Yeni Sürü Ekle */}
      {clickedCoord && (
        <AddHerdModal
          coord={clickedCoord}
          campaignId={campaignId}
          districtId={campaign?.district_id}
          plateCode={campaign?.districts?.province_id || 48}
          districtNeighbourhoods={districtNeighbourhoods}
          userId={profile?.id}
          campaignSpecies={species}
          onClose={() => setClicked(null)}
          onAdded={() => { setClicked(null); fetchHerds(); showToast('Sürü eklendi', 'success') }}
          showToast={showToast}
        />
      )}

      {/* Yeni Görev Başlat */}
      {showStartMission && (
        <StartMissionModal
          campaignId={campaignId}
          districtId={campaign?.district_id}
          districtNeighbourhoods={districtNeighbourhoods}
          userId={profile?.id}
          onClose={() => setShowStartMission(false)}
          onStarted={() => {
            setShowStartMission(false)
            fetchActiveMission()
            showToast('🚀 Görev başlatıldı, iyi çalışmalar!', 'success')
          }}
        />
      )}

      {/* Görevi Bitir */}
      {showFinish && activeMission && (
        <FinishDayModal
          campaignId={campaignId}
          campaignSpecies={species}
          activeMission={activeMission}
          userId={profile?.id}
          operationDate={campaign?.operation_date}
          detectedHerds={herds.filter(h => h.visit_status === 'detected')}
          onClose={() => setShowFinish(false)}
          onDone={() => { setShowFinish(false); setActiveMission(null); fetchHerds(); showToast('Görev başarıyla tamamlandı!', 'success') }}
        />
      )}

      {/* Personel Davet Modalı */}
      {showInvite && (
        <InviteStaffModal
          campaignId={campaignId}
          districtId={campaign?.district_id}
          onClose={() => setShowInvite(false)}
          showToast={showToast}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="toast-container">
          <div className={`toast toast--${toast.type}`}>{toast.msg}</div>
        </div>
      )}
    </div>
  )
}

// ─── Sürü Marker Bileşeni ────────────────────────────────────────────────────
function HerdMarker({ herd, onSelect }) {
  const icon = createHerdIcon(herd.visit_status, herd.dominant_species)
  return (
    <Marker
      position={[herd.lat, herd.lng]}
      icon={icon}
      eventHandlers={{ click: () => onSelect(herd) }}
    />
  )
}

// ─── Sürü Detay Popup ────────────────────────────────────────────────────────
function HerdPopup({ herd, campaignId, profile, onClose, onVisited, onReverted, onRefresh, showToast }) {
  const statusLabel = { pending: '⚪ Bekliyor', detected: '🟡 Tespit Edildi', visited: '🟢 Ziyaret Edildi' }

  // Ad + Soyad birleştir (her ikisi de maskeli)
  const ownerFull = [herd.owner_name_masked, herd.owner_surname_masked].filter(Boolean).join(' ') || null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <div className="modal__header">
          <span>Sürü Detayı</span>
          <button className="btn btn--ghost btn--sm" onClick={onClose}>✕</button>
        </div>
        <div className="modal__body">

          {/* İşletme No + Mahalle */}
          <div style={{ marginBottom: '.75rem', padding: '.75rem', background: 'var(--color-surface2)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ fontWeight: 600, fontSize: '.95rem' }}>{herd.enterprise_id}</div>
            <div style={{ color: 'var(--color-muted)', fontSize: '.82rem', marginTop: '.2rem' }}>
              {herd.neighbourhood_name || '—'}
            </div>
          </div>

          {/* Kişisel Bilgiler (maskeli) */}
          {(ownerFull || herd.father_name_masked || herd.tc_masked || herd.phone) && (
            <div style={{
              marginBottom: '.75rem', padding: '.65rem .75rem',
              background: 'var(--color-surface2)', borderRadius: 'var(--radius-sm)',
              display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '.3rem .75rem',
              alignItems: 'center', fontSize: '.82rem'
            }}>
              {ownerFull && (
                <>
                  <span style={{ color: 'var(--color-muted)', whiteSpace: 'nowrap' }}>Sahip</span>
                  <span style={{ fontWeight: 500 }}>{ownerFull}</span>
                </>
              )}
              {herd.father_name_masked && (
                <>
                  <span style={{ color: 'var(--color-muted)', whiteSpace: 'nowrap' }}>Baba Adı</span>
                  <span style={{ fontWeight: 500 }}>{herd.father_name_masked}</span>
                </>
              )}
              {herd.tc_masked && (
                <>
                  <span style={{ color: 'var(--color-muted)', whiteSpace: 'nowrap' }}>TC/VKN</span>
                  <span style={{ fontWeight: 500, fontFamily: 'monospace', letterSpacing: '.05em' }}>{herd.tc_masked}</span>
                </>
              )}
              {herd.phone && (
                <>
                  <span style={{ color: 'var(--color-muted)', whiteSpace: 'nowrap' }}>Telefon</span>
                  <span style={{ fontWeight: 500 }}>{herd.phone}</span>
                </>
              )}
            </div>
          )}

          {/* Hayvan Sayıları */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '.5rem', marginBottom: '.75rem' }}>
            {[
              { label: 'Sığır', count: herd.sigir_count, emoji: '🐄' },
              { label: 'Manda', count: herd.manda_count, emoji: '🐃' },
              { label: 'Koyun', count: herd.koyun_count, emoji: '🐑' },
              { label: 'Keçi', count: herd.keci_count, emoji: '🐐' },
            ].filter(a => a.count > 0).map(a => (
              <div key={a.label} style={{
                textAlign: 'center', padding: '.5rem',
                background: 'var(--color-surface2)', borderRadius: 'var(--radius-sm)'
              }}>
                <div style={{ fontSize: '1.2rem' }}>{a.emoji}</div>
                <div style={{ fontWeight: 700 }}>{a.count}</div>
                <div style={{ fontSize: '.72rem', color: 'var(--color-muted)' }}>{a.label}</div>
              </div>
            ))}
          </div>

          {/* Durum */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '.5rem .75rem', background: 'var(--color-surface2)', borderRadius: 'var(--radius-sm)'
          }}>
            <span style={{ fontSize: '.85rem' }}>Durum: {statusLabel[herd.visit_status]}</span>
            <span style={{ fontSize: '.82rem', color: 'var(--color-muted)' }}>Sürü #{herd.herd_number}</span>
          </div>
        </div>

        <div className="modal__footer">
          <button className="btn btn--ghost" onClick={onClose}>Kapat</button>

          {/* Ziyareti Geri Al — sadece visited durumunda */}
          {herd.visit_status === 'visited' && (
            <button
              className="btn btn--warning btn--sm"
              id="btn-revert-visit"
              onClick={onReverted}
              title="Ziyareti geri al — Bekliyor durumuna çek"
            >
              ↩️ Geri Al
            </button>
          )}

          {/* Ziyaret Edildi */}
          {herd.visit_status !== 'visited' && (
            <button
              className="btn btn--success"
              onClick={onVisited}
              id="btn-mark-visited"
            >
              ✅ Ziyaret Edildi (Onayla)
            </button>
          )}
        </div>
      </div>
    </div>
  )
}


// ─── Yeni Sürü Ekle Modal ────────────────────────────────────────────────────
function AddHerdModal({ coord, campaignId, districtId, plateCode, districtNeighbourhoods, userId, campaignSpecies, onClose, onAdded, showToast }) {
  const [enterpriseId, setEnterpriseId] = useState('')
  const [isTemporal, setTemporal] = useState(false)
  const [herdSpecies, setHerdSpecies] = useState(campaignSpecies)
  const [selectedNeighbourhood, setSelectedNeighbourhood] = useState('')

  const [dbEnterprise, setDbEnterprise] = useState(null)
  const [existing, setExisting] = useState(null)  // Mükerrer kontrol
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Veritabanı sorgulama (Getir butonu ile)
  async function checkEnterprise() {
    if (!enterpriseId.trim()) return
    setChecking(true)
    setError('')
    setDbEnterprise(null)
    setExisting(null)

    // Pad mantığı kullanıcının il profiline göre çalışacak
    const searchId = formatPartialEnterpriseId(enterpriseId, plateCode) || enterpriseId.trim().toUpperCase()
    setEnterpriseId(searchId)

    const { data: entData } = await supabase
      .from('enterprises')
      .select('*, neighbourhoods(name)')
      .eq('id', searchId)
      .single()

    if (entData) {
      setDbEnterprise(entData)
      if (entData.neighbourhood_id) setSelectedNeighbourhood(entData.neighbourhood_id)
    } else {
      setError('Veritabanında bulunamadı! Yeni kaydedilecek.')
    }

    const { data: herdData } = await supabase
      .from('herds')
      .select('id, herd_number')
      .eq('enterprise_id', searchId)
    if (herdData?.length) setExisting(herdData)

    setChecking(false)
  }

  async function handleAdd() {
    setSaving(true)
    setError('')
    try {
      const entId = isTemporal ? generateTempId() : enterpriseId.trim()

      if (!entId) { setError('İşletme no gerekli'); setSaving(false); return }
      if (!selectedNeighbourhood) { setError('Lütfen mahalle seçiniz!'); setSaving(false); return }

      // İşletme yoksa oluştur veya opsiyonel mahallesi güncellensin
      await supabase.from('enterprises').upsert(
        { id: entId, district_id: districtId, neighbourhood_id: selectedNeighbourhood },
        { onConflict: 'id' }
      )

      // Sürü no belirle
      const herdNo = existing ? (existing.length + 1) : 1

      // Sürü ekle
      const { error: herdErr } = await supabase.from('herds').insert({
        enterprise_id: entId,
        herd_number: herdNo,
        location: `POINT(${coord[1]} ${coord[0]})`,
        species: herdSpecies,
        district_id: districtId
      })

      if (herdErr) throw herdErr

      // İlk ziyaret log'u oluştur (pending)
      if (isTemporal) {
        await supabase.from('temp_enterprises').insert({
          temp_id: entId,
          district_id: districtId
        })
      }

      onAdded()
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  const speciesList = [
    { value: 'sigir', label: '🐄 Sığır' },
    { value: 'manda', label: '🐃 Manda' },
    { value: 'koyun', label: '🐑 Koyun' },
    { value: 'keci', label: '🐐 Keçi' },
  ]

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal__header">
          <span>➕ Sürü Ekle</span>
          <button className="btn btn--ghost btn--sm" onClick={onClose}>✕</button>
        </div>
        <div className="modal__body">
          <div style={{ padding: '.5rem .75rem', background: 'var(--color-surface2)', borderRadius: 'var(--radius-sm)', marginBottom: '1rem', fontSize: '.82rem', color: 'var(--color-muted)' }}>
            📍 Konum: {coord[0].toFixed(6)}, {coord[1].toFixed(6)}
          </div>

          <div style={{ display: 'flex', gap: '.5rem', marginBottom: '1rem' }}>
            <button
              className={`btn btn--sm ${!isTemporal ? 'btn--primary' : 'btn--ghost'}`}
              onClick={() => setTemporal(false)}
            >Sistemdeki İşletme</button>
            <button
              className={`btn btn--sm ${isTemporal ? 'btn--warning' : 'btn--ghost'}`}
              onClick={() => setTemporal(true)}
              style={isTemporal ? { color: '#fff', background: 'var(--color-warning)' } : {}}
            >Geçici (Kayıtsız)</button>
          </div>

          {!isTemporal && (
            <div className="form-group">
              <label className="form-label">İşletme No</label>
              <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
                <input
                  id="input-enterprise-id"
                  className="form-control"
                  style={{ flex: 1 }}
                  placeholder="123 yazıp Getir'e basın"
                  value={enterpriseId}
                  onChange={e => setEnterpriseId(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && checkEnterprise()}
                />
                <button type="button" className="btn btn--primary btn--sm" onClick={checkEnterprise} disabled={checking}>
                  Getir
                </button>
                {checking && <div className="spinner" style={{ width: 24, height: 24, borderWidth: 2, flexShrink: 0 }} />}
              </div>
            </div>
          )}

          {/* İşletme Bilgileri Kartı */}
          {dbEnterprise && !isTemporal && (
            <div style={{
              padding: '.75rem', marginBottom: '1rem',
              background: 'rgba(39, 174, 96, 0.1)', border: '1px solid rgba(39, 174, 96, 0.3)',
              borderRadius: 'var(--radius-sm)', fontSize: '.85rem'
            }}>
              <div style={{ marginBottom: '.25rem' }}><strong>TC / VKN:</strong> {dbEnterprise.tc_masked || dbEnterprise.vkn_masked || 'Bilinmiyor'}</div>
              <div style={{ marginBottom: '.25rem' }}>
                <strong>Sahibi:</strong> {[dbEnterprise.owner_name_masked, dbEnterprise.owner_surname_masked].filter(Boolean).join(' ') || 'Bilinmiyor'}
              </div>
              <div style={{ marginBottom: '.25rem' }}><strong>Baba Adı:</strong> {dbEnterprise.father_name_masked || 'Bilinmiyor'}</div>
              <div style={{ marginBottom: '.25rem' }}><strong>Telefon:</strong> {dbEnterprise.phone || 'Bilinmiyor'}</div>
              <div style={{ marginTop: '.5rem', display: 'flex', gap: '1rem' }}>
                <span>🐄 {dbEnterprise.sigir_count || 0}</span>
                <span>🐃 {dbEnterprise.manda_count || 0}</span>
                <span>🐑 {dbEnterprise.koyun_count || 0}</span>
                <span>🐐 {dbEnterprise.keci_count || 0}</span>
              </div>
            </div>
          )}

          {/* Mahalle Seçimi */}
          <div className="form-group">
            <label className="form-label">Mahalle (Zorunlu)</label>
            <select
              className="form-control"
              value={selectedNeighbourhood}
              onChange={e => setSelectedNeighbourhood(e.target.value)}
            >
              <option value="">-- Seçiniz --</option>
              {districtNeighbourhoods.map(n => (
                <option key={n.id} value={n.id}>{n.name}</option>
              ))}
            </select>
          </div>

          {/* Mükerrer uyarısı */}
          {existing && (
            <div style={{
              padding: '.75rem', marginBottom: '.75rem',
              background: 'rgba(243,156,18,.1)', border: '1px solid rgba(243,156,18,.3)',
              borderRadius: 'var(--radius-sm)', fontSize: '.85rem'
            }}>
              <strong>⚠️ Bu işletme zaten kayıtlı!</strong>
              <p style={{ color: 'var(--color-muted)', marginTop: '.35rem' }}>
                {existing.length} adet sürüsü bulunuyor.
                Yeni sürü eklerseniz <strong>Sürü-{existing.length + 1}</strong> olarak açılır.
              </p>
            </div>
          )}

          {/* Türler */}
          <div className="form-group" style={{ marginTop: '1rem' }}>
            <label className="form-label">Bu konumdaki hayvan türleri</label>
            <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', marginTop: '.3rem' }}>
              {speciesList.map(s => (
                <button
                  key={s.value}
                  className={`btn btn--sm ${herdSpecies.includes(s.value) ? 'btn--primary' : 'btn--ghost'}`}
                  onClick={() => setHerdSpecies(prev =>
                    prev.includes(s.value) ? prev.filter(x => x !== s.value) : [...prev, s.value]
                  )}
                  type="button"
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {error && (
            <div style={{ color: 'var(--color-danger)', fontSize: '.85rem', padding: '.5rem', background: 'rgba(231,76,60,.1)', borderRadius: 'var(--radius-sm)' }}>
              ⚠️ {error}
            </div>
          )}
        </div>
        <div className="modal__footer">
          <button className="btn btn--ghost" onClick={onClose}>İptal</button>
          <button
            className="btn btn--primary"
            onClick={handleAdd}
            disabled={saving || (!isTemporal && !enterpriseId)}
            id="btn-confirm-add-herd"
          >
            {saving ? '⏳ Kaydediliyor...' : existing ? `Sürü-${existing.length + 1} Ekle` : '📍 Sürü Ekle'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Yeni Görev Başlat Modal ────────────────────────────────────────────────
function StartMissionModal({ campaignId, districtId, districtNeighbourhoods, userId, onClose, onStarted }) {
  const [selectedNeighbourhood, setSelectedNeighbourhood] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleStart() {
    if (!selectedNeighbourhood) return alert('Lütfen çalışacağınız mahalleyi seçiniz.');
    setSaving(true);
    const today = new Date().toISOString().slice(0, 10);
    const { error } = await supabase.from('daily_missions').insert({
      campaign_id: campaignId,
      user_id: userId,
      district_id: districtId,
      neighbourhood_id: parseInt(selectedNeighbourhood, 10),
      operation_date: today
    });
    setSaving(false);
    if (error) alert("Hata: " + error.message);
    else onStarted();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal__header">
          <span>🚀 Yeni Görev Başlat</span>
          <button className="btn btn--ghost btn--sm" onClick={onClose}>✕</button>
        </div>
        <div className="modal__body">
          <p style={{ fontSize: '.85rem', color: 'var(--color-muted)', marginBottom: '1rem' }}>
            Çalışacağınız mahalleyi seçerek bugünkü görevinizi başlatın. Operasyon verileriniz bu görev üzerine kaydedilecektir.
          </p>
          <div className="form-group">
            <label className="form-label">Çalışılacak Mahalle</label>
            <select
              className="form-control"
              value={selectedNeighbourhood}
              onChange={e => setSelectedNeighbourhood(e.target.value)}
            >
              <option value="">-- Mahalle Seçin --</option>
              {districtNeighbourhoods.map(n => (
                <option key={n.id} value={n.id}>{n.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="modal__footer">
          <button className="btn btn--ghost" onClick={onClose}>İptal</button>
          <button className="btn btn--success" onClick={handleStart} disabled={saving || !selectedNeighbourhood}>
            {saving ? '⏳ Başlatılıyor...' : '🚀 Görevi Başlat'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Görevi Bitir Modal ───────────────────────────────────────────────────────
function FinishDayModal({ campaignId, campaignSpecies, activeMission, userId, operationDate, detectedHerds, onClose, onDone }) {
  const today = new Date().toISOString().slice(0, 10)
  const opDate = operationDate || today

  const [vaccineCount, setVaccineCount] = useState('')
  const [approved, setApproved] = useState([])
  const [summary, setSummary] = useState(null)
  const [saving, setSaving] = useState(false)

  // İstatistikler
  useEffect(() => {
    fetchSummary()
  }, [])

  async function fetchSummary() {
    const { data } = await supabase.rpc('get_daily_summary', {
      p_campaign_id: campaignId,
      p_user_id: userId,
      p_date: opDate
    })
    if (data?.[0]) setSummary(data[0])
  }

  function toggleApprove(herdId) {
    setApproved(prev =>
      prev.includes(herdId) ? prev.filter(id => id !== herdId) : [...prev, herdId]
    )
  }

  async function handleFinish() {
    setSaving(true)
    // Seçilen detected sürüleri yeşile çevir
    for (const herdId of approved) {
      const { data: existing } = await supabase
        .from('visit_logs')
        .select('id')
        .eq('campaign_id', campaignId)
        .eq('herd_id', herdId)
        .single()

      if (existing) {
        await supabase.from('visit_logs').update({
          user_id: userId,
          status: 'visited',
          visited_at: new Date().toISOString()
        }).eq('id', existing.id)
      } else {
        await supabase.from('visit_logs').insert({
          campaign_id: campaignId,
          herd_id: herdId,
          user_id: userId,
          status: 'visited',
          visited_at: new Date().toISOString(),
          operation_date: opDate
        })
      }
    }

    // Görev log'unu (Mission) güncelle
    const vc = parseInt(vaccineCount, 10) || 0
    await supabase.from('daily_missions').update({
      vaccine_count_applied: vc,
      visited_enterprise_count: summary?.visited_enterprise_count || 0,
      total_animals_visited: summary?.total_animals_count || 0,
      finished_at: new Date().toISOString()
    }).eq('id', activeMission.id)

    onDone()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal__header">
          <span>🏁 Görevi Bitir</span>
          <button className="btn btn--ghost btn--sm" onClick={onClose}>✕</button>
        </div>
        <div className="modal__body">
          <p style={{ color: 'var(--color-muted)', fontSize: '.85rem', marginBottom: '1rem' }}>
            Operasyon Tarihi: <strong>{opDate}</strong>
          </p>

          {/* Günlük İstatistikler */}
          {summary && (() => {
            const targetTotal = ['sigir', 'manda', 'koyun', 'keci'].reduce((acc, code) => {
              if (campaignSpecies?.includes(code)) return acc + (summary[`${code}_total`] || 0);
              return acc;
            }, 0);

            return (
              <div style={{ marginBottom: '1rem' }}>
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr 1fr',
                  gap: '.75rem', marginBottom: '.75rem'
                }}>
                  <div style={{ padding: '.75rem', background: 'var(--color-surface2)', borderRadius: 'var(--radius-sm)', textAlign: 'center' }}>
                    <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--color-success)' }}>
                      {summary.visited_enterprise_count}
                    </div>
                    <div style={{ fontSize: '.75rem', color: 'var(--color-muted)' }}>Ziyaret Edilen İşletme</div>
                  </div>
                  <div style={{ padding: '.75rem', background: 'var(--color-surface2)', borderRadius: 'var(--radius-sm)', textAlign: 'center' }}>
                    <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--color-primary)' }}>
                      {targetTotal}
                    </div>
                    <div style={{ fontSize: '.75rem', color: 'var(--color-muted)' }}>Hedef Hayvan Toplamı</div>
                  </div>
                </div>

                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '.4rem'
                }}>
                  {[
                    { key: 'sigir_total', label: 'Sığır', emoji: '🐄', code: 'sigir' },
                    { key: 'manda_total', label: 'Manda', emoji: '🐃', code: 'manda' },
                    { key: 'koyun_total', label: 'Koyun', emoji: '🐑', code: 'koyun' },
                    { key: 'keci_total', label: 'Keçi', emoji: '🐐', code: 'keci' }
                  ].map(item => {
                    const isTarget = campaignSpecies?.includes(item.code);
                    return (
                      <div key={item.key} style={{
                        padding: '.5rem', textAlign: 'center',
                        background: isTarget ? 'rgba(39, 174, 96, 0.15)' : 'var(--color-surface2)',
                        border: isTarget ? '1px solid rgba(39, 174, 96, 0.4)' : '1px solid transparent',
                        borderRadius: 'var(--radius-sm)',
                        opacity: isTarget ? 1 : 0.6
                      }}>
                        <div style={{ fontSize: '1rem' }}>{item.emoji} {summary[item.key] || 0}</div>
                        <div style={{ fontSize: '.7rem', fontWeight: isTarget ? 700 : 400, color: isTarget ? 'var(--color-success)' : 'var(--color-muted)' }}>
                          {item.label}
                        </div>
                      </div>
                    )
                  })}
                </div>
                <p style={{ fontSize: '.75rem', color: 'var(--color-muted)', marginTop: '.5rem', textAlign: 'center' }}>
                  ⚠️ <em>İşletmelerdeki hayvan sayısını simgeler. Aynı işletmenin farklı sürüleri sadece 1 kez toplanmıştır.</em>
                </p>
              </div>
            );
          })()}

          {/* Tespit Edilmiş (Sarı) Listesi — Onay bekleniyor */}
          {detectedHerds.length > 0 && (
            <div style={{ marginBottom: '1rem' }}>
              <label className="form-label" style={{ marginBottom: '.5rem', display: 'block' }}>
                🟡 Tespit Edilen İşletmeler (Onaylamak istediklerinizi seçin)
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem', maxHeight: 160, overflowY: 'auto' }}>
                {detectedHerds.map(h => (
                  <label key={h.herd_id} style={{
                    display: 'flex', alignItems: 'center', gap: '.5rem',
                    padding: '.5rem .75rem', background: 'var(--color-surface2)',
                    borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                    border: approved.includes(h.herd_id) ? '1px solid var(--color-success)' : '1px solid transparent'
                  }}>
                    <input
                      type="checkbox"
                      checked={approved.includes(h.herd_id)}
                      onChange={() => toggleApprove(h.herd_id)}
                    />
                    <span style={{ fontSize: '.85rem' }}>{h.enterprise_id}</span>
                    <span style={{ fontSize: '.78rem', color: 'var(--color-muted)', marginLeft: 'auto' }}>
                      {h.neighbourhood_name}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Aşı Sayısı */}
          <div className="form-group">
            <label className="form-label">Uygulanan Toplam Aşı Sayısı</label>
            <input
              id="input-vaccine-count"
              className="form-control"
              type="number"
              min="0"
              placeholder="0"
              value={vaccineCount}
              onChange={e => setVaccineCount(e.target.value)}
            />
            {summary && (
              <p style={{ fontSize: '.78rem', color: 'var(--color-muted)', marginTop: '.3rem' }}>
                ℹ️ {summary.visited_enterprise_count} işletme ziyaret ettiniz,
                toplam {summary.total_animals_count} hayvan
              </p>
            )}
          </div>
        </div>
        <div className="modal__footer">
          <button className="btn btn--ghost" onClick={onClose}>İptal</button>
          <button
            className="btn btn--success"
            onClick={handleFinish}
            disabled={saving}
            id="btn-confirm-finish"
          >
            {saving ? '⏳ Kaydediliyor...' : '✅ Günü Tamamla'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Personel Davet Modalı ───────────────────────────────────────────────────
function InviteStaffModal({ campaignId, districtId, onClose, showToast }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [invitedMap, setInvitedMap] = useState({}) // Hangi user_id invite edilmiş/bekliyor

  useEffect(() => {
    fetchUsers()
  }, [])

  async function fetchUsers() {
    setLoading(true)
    const { data: allUsers } = await supabase
      .from('profiles')
      .select('id, full_name, email, role, district_id')
      .in('role', ['field_staff', 'district_admin'])
      .order('full_name')

    const { data: staffData } = await supabase
      .from('campaign_staff')
      .select('user_id, is_active')
      .eq('campaign_id', campaignId)

    const map = {}
    if (staffData) {
      staffData.forEach(s => map[s.user_id] = s.is_active)
    }
    setInvitedMap(map)
    setUsers(allUsers || [])
    setLoading(false)
  }

  async function toggleInvite(userId, currentStatus) {
    if (currentStatus === undefined) {
      const { data: myProf } = await supabase.auth.getUser()
      const { error } = await supabase.from('campaign_staff').insert({
        campaign_id: campaignId,
        user_id: userId,
        invited_by: myProf?.user?.id
      })
      if (!error) {
        showToast('Davet gönderildi', 'success')
        fetchUsers()
      } else {
        showToast('Hata: ' + error.message, 'danger')
      }
    } else {
      const { error } = await supabase.from('campaign_staff').update({
        is_active: !currentStatus
      }).eq('campaign_id', campaignId).eq('user_id', userId)

      if (!error) {
        showToast('Durum güncellendi', 'success')
        fetchUsers()
      } else {
        showToast('Hata: ' + error.message, 'danger')
      }
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 500 }}>
        <div className="modal__header">
          <span>👥 Personel Davet İşlemleri</span>
          <button className="btn btn--ghost btn--sm" onClick={onClose}>✕</button>
        </div>
        <div className="modal__body">
          <p style={{ fontSize: '.85rem', color: 'var(--color-muted)', marginBottom: '1rem' }}>
            Bu kampanyada görev alacak saha personellerini aşağıdan seçerek davet edebilirsiniz.
          </p>

          {loading ? (
            <div className="spinner" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem', maxHeight: 300, overflowY: 'auto' }}>
              {users.map(u => {
                const status = invitedMap[u.id]
                const isInvited = status !== undefined

                return (
                  <div key={u.id} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '.5rem .75rem', background: 'var(--color-surface2)', borderRadius: 'var(--radius-sm)'
                  }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '.9rem' }}>{u.full_name || u.email}</div>
                      <div style={{ fontSize: '.75rem', color: 'var(--color-muted)' }}>
                        {u.role === 'field_staff' ? '👨‍⚕️ Saha Personeli' : '🛡️ Yönetici'}
                        {u.district_id !== districtId ? ' (Farklı İlçe/Bölge)' : ''}
                      </div>
                    </div>
                    <button
                      className={`btn btn--sm ${isInvited ? (status ? 'btn--success' : 'btn--ghost') : 'btn--primary'}`}
                      onClick={() => toggleInvite(u.id, status)}
                    >
                      {isInvited ? (status ? 'Yetkiyi Kaldır' : 'Kapalı (Aç)') : 'Davet Et'}
                    </button>
                  </div>
                )
              })}
              {users.length === 0 && <div style={{ fontSize: '.85rem', color: 'var(--color-muted)' }}>Personel bulunamadı.</div>}
            </div>
          )}
        </div>
        <div className="modal__footer">
          <button className="btn btn--ghost" onClick={onClose}>Kapat</button>
        </div>
      </div>
    </div>
  )
}
