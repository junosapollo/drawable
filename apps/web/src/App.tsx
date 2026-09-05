import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'

const DrawPage = lazy(() => import('./pages/DrawPage'))
const CuratePage = lazy(() => import('./pages/CuratePage'))
const BenchmarkPage = lazy(() => import('./pages/BenchmarkPage'))
const SetupPage = lazy(() => import('./pages/SetupPage'))

function AppLoading() {
  return <div className="app-loading" role="status">Opening workspace…</div>
}

export function App() {
  return (
    <Suspense fallback={<AppLoading />}>
      <Routes>
        <Route path="/" element={<Navigate to="/draw" replace />} />
        <Route path="/draw" element={<DrawPage />} />
        <Route path="/curate" element={<CuratePage />} />
        <Route path="/benchmark" element={<BenchmarkPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="*" element={<Navigate to="/draw" replace />} />
      </Routes>
    </Suspense>
  )
}
