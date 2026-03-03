import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider } from './hooks/useAppState';
import { Layout } from './components/layout/Layout';

// ---------------------------------------------------------------------------
// Lazy-loaded pages for route-based code splitting
// ---------------------------------------------------------------------------
const ExecutiveSummary = lazy(() =>
  import('./pages/ExecutiveSummary').then(m => ({ default: m.ExecutiveSummary })),
);
const TitleAnalysis = lazy(() =>
  import('./pages/TitleAnalysis').then(m => ({ default: m.TitleAnalysis })),
);
const PlatformAnalysis = lazy(() =>
  import('./pages/PlatformAnalysis').then(m => ({ default: m.PlatformAnalysis })),
);
const PeriodAnalysis = lazy(() =>
  import('./pages/PeriodAnalysis').then(m => ({ default: m.PeriodAnalysis })),
);
const Trends = lazy(() =>
  import('./pages/Trends').then(m => ({ default: m.Trends })),
);
const RawData = lazy(() =>
  import('./pages/RawData').then(m => ({ default: m.RawData })),
);
const SalesStructure = lazy(() =>
  import('./pages/SalesStructure').then(m => ({ default: m.SalesStructure })),
);

// Minimal page-level loading indicator
function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-[40vh]">
      <div className="w-8 h-8 border-3 border-primary/30 border-t-primary rounded-full animate-spin" />
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AppProvider>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<Navigate to="/summary" replace />} />
              <Route path="/summary" element={<ExecutiveSummary />} />
              <Route path="/titles" element={<TitleAnalysis />} />
              <Route path="/platforms" element={<PlatformAnalysis />} />
              <Route path="/period" element={<PeriodAnalysis />} />
              <Route path="/dynamics" element={<Navigate to="/platforms" replace />} />
              <Route path="/structure" element={<SalesStructure />} />
              <Route path="/trends" element={<Trends />} />
              <Route path="/data" element={<RawData />} />
            </Route>
          </Routes>
        </Suspense>
      </AppProvider>
    </BrowserRouter>
  );
}

export default App;
