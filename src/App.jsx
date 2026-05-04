import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import CampaignPage from './pages/CampaignPage'
import AdminPage from './pages/AdminPage'
import ExcelUploadPage from './pages/ExcelUploadPage'
import Navbar from './components/Navbar'

function AppRoutes() {
  const { session, profile, loading } = useAuth()

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <span>Yükleniyor...</span>
      </div>
    )
  }

  if (!session) return <LoginPage />

  return (
    <div className="app-container">
      <Navbar />
      <main className="page-content">
        <Routes>
          <Route path="/"              element={<DashboardPage />} />
          <Route path="/kampanya/:id"  element={<CampaignPage />} />
          <Route path="/excel-yukle"   element={<ExcelUploadPage />} />
          <Route path="/admin"         element={<AdminPage />} />
          <Route path="*"              element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter basename="/vetsis">
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  )
}
