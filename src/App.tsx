import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider } from './hooks/useAppState';
import { Layout } from './components/layout/Layout';
import { ExecutiveSummary } from './pages/ExecutiveSummary';
import { TitleAnalysis } from './pages/TitleAnalysis';
import { PlatformAnalysis } from './pages/PlatformAnalysis';
import { PeriodAnalysis } from './pages/PeriodAnalysis';
import { Trends } from './pages/Trends';
import { RawData } from './pages/RawData';

function App() {
  return (
    <BrowserRouter>
      <AppProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Navigate to="/summary" replace />} />
            <Route path="/summary" element={<ExecutiveSummary />} />
            <Route path="/titles" element={<TitleAnalysis />} />
            <Route path="/platforms" element={<PlatformAnalysis />} />
            <Route path="/period" element={<PeriodAnalysis />} />
            <Route path="/trends" element={<Trends />} />
            <Route path="/data" element={<RawData />} />
          </Route>
        </Routes>
      </AppProvider>
    </BrowserRouter>
  );
}

export default App;
