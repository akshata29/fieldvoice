import { lazy } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { EmptyState } from '@/components/ui/Feedback';
import { buttonClasses } from '@/components/ui/Button';

const TodayPage = lazy(() => import('@/pages/TodayPage'));
const MorningPage = lazy(() => import('@/pages/MorningPage'));
const JobPage = lazy(() => import('@/pages/JobPage'));
const SyncPage = lazy(() => import('@/pages/SyncPage'));
const LabPage = lazy(() => import('@/pages/LabPage'));
const ResultsPage = lazy(() => import('@/pages/ResultsPage'));
const DatasetsTab = lazy(() => import('@/pages/results/DatasetsTab'));
const RunsTab = lazy(() => import('@/pages/results/RunsTab'));
const RunDetail = lazy(() => import('@/pages/results/RunDetail'));
const ModelsPage = lazy(() => import('@/pages/ModelsPage'));
const AboutPage = lazy(() => import('@/pages/AboutPage'));

function NotFound() {
  return (
    <EmptyState
      title="That page does not exist"
      action={
        <Link to="/" className={buttonClasses({ variant: 'primary' })}>
          Back to Today
        </Link>
      }
    >
      Use the navigation to pick a screen.
    </EmptyState>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<TodayPage />} />
        <Route path="morning" element={<MorningPage />} />
        <Route path="jobs/:id" element={<JobPage />} />
        <Route path="sync" element={<SyncPage />} />
        <Route path="lab" element={<LabPage />} />
        <Route path="results" element={<ResultsPage />}>
          <Route index element={<Navigate to="datasets" replace />} />
          <Route path="datasets" element={<DatasetsTab />} />
          <Route path="runs" element={<RunsTab />} />
          <Route path="runs/:runId" element={<RunDetail />} />
        </Route>
        <Route path="models" element={<ModelsPage />} />
        <Route path="about" element={<AboutPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
