// Manager approval queue: FALSE_POSITIVE proposals above the maker-checker limit (FR-7).
import { useApi, useLiveRefresh } from '../lib/session';
import { Empty, ErrorBanner, Loading, PageHeader, Section } from '../components/ui';
import { AlertTable } from './Alerts';

export default function Approvals() {
  const list = useApi('/alerts?status=PENDING_MANAGER_APPROVAL');
  useLiveRefresh(['alert_updated'], list.reload);
  return (
    <div>
      <PageHeader title="Approvals" subtitle="False-positive proposals above INR 1,00,000 need a Fraud Risk Manager who did not propose them." />
      <ErrorBanner error={list.error} onRetry={list.reload} />
      <Section>
        {!list.data ? <Loading /> : list.data.alerts.length === 0 ? <Empty title="Nothing waiting for approval">Proposals appear here as soon as an analyst sends one.</Empty>
          : <AlertTable alerts={list.data.alerts} canClaim={false} />}
      </Section>
    </div>
  );
}
