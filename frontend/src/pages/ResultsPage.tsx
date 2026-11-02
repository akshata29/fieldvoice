import { Link, Outlet, useMatch } from 'react-router-dom';
import { PageHeader } from '@/components/ui/Card';
import { Tabs, type TabItem } from '@/components/ui/Tabs';
import { DemoBanner } from '@/components/domain/DemoTag';

export default function ResultsPage() {
  const match = useMatch('/results/runs/:runId');
  const runId = match?.params.runId;
  const tabs: TabItem[] = [
    { id: 'datasets', label: 'Datasets', to: '/results/datasets' },
    { id: 'runs', label: 'Runs', to: '/results/runs' },
    ...(runId ? [{ id: 'detail', label: `Run ${runId}`, to: `/results/runs/${encodeURIComponent(runId)}` } satisfies TabItem] : []),
  ];
  return (
    <>
      <PageHeader
        eyebrow="Evaluation"
        title="Results"
        subtitle={
          <>
            Synthetic datasets, evaluation runs and the decision view that compares speech engines, models and strategies.{' '}
            <Link to="/lab" className="font-semibold text-brand-700 hover:underline">
              Try one utterance in the Lab
            </Link>
            .
          </>
        }
      />
      <DemoBanner />
      <Tabs label="Results sections" items={tabs} className="mb-5" />
      <Outlet />
    </>
  );
}
