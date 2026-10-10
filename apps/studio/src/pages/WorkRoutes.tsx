import { FormStats } from '../components/FormStats';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import RecordsInboxPage from '../form/pages/RecordsInboxPage';
import WorkDashboardPage from '../form/pages/WorkDashboardPage';
import NewWorkItemPage from '../form/pages/NewWorkItemPage';
import WorkingTimePage from '../form/pages/WorkingTimePage';
import WebhooksPage from '../form/pages/WebhooksPage';
import WorkflowsPage from '../form/pages/WorkflowsPage';
import ExtensionsPage from '../form/pages/ExtensionsPage';
import FragmentsPage from '../form/pages/FragmentsPage';
import ListsPage from '../form/pages/ListsPage';
import EmailTemplatesPage from '../form/pages/EmailTemplatesPage';
import SubmissionsPage from '../form/pages/SubmissionsPage';
import '../form/styles/form-builder.css';
import '../form/styles/work-inbox.css';
import '../form/styles/work-dashboard.css';

/** Route wrappers for the ported Sangam work pages (loaded on demand, like the builder). */
export function InboxRoute() {
  const [params, setParams] = useSearchParams();
  return (
    <RecordsInboxPage
      recordId={params.get('record') ?? undefined}
      preset={params.get('preset') ?? undefined}
      onOpenRecord={(id) =>
        setParams(
          (p) => {
            if (id) p.set('record', id);
            else p.delete('record');
            return p;
          },
          { replace: !id },
        )
      }
    />
  );
}

export function DashboardRoute() {
  const navigate = useNavigate();
  return <WorkDashboardPage onOpenView={(preset) => navigate(`/work?preset=${encodeURIComponent(preset)}`)} />;
}

export function NewWorkItemRoute() {
  const navigate = useNavigate();
  return <NewWorkItemPage onOpen={(id) => navigate(`/work?record=${encodeURIComponent(id)}`)} />;
}

export function WorkingTimeRoute() {
  return <WorkingTimePage />;
}

export function WebhooksRoute() {
  return <WebhooksPage />;
}

export function WorkflowsRoute() {
  return <WorkflowsPage />;
}

export function FragmentsRoute() {
  return <FragmentsPage />;
}

export function ListsRoute() {
  return <ListsPage />;
}

export function EmailTemplatesRoute() {
  return <EmailTemplatesPage />;
}

export function ExtensionsRoute() {
  return <ExtensionsPage />;
}

export function SubmissionsRoute() {
  const { id } = useParams();
  const navigate = useNavigate();
  return (
    <>
      {id && (
        <div style={{ padding: '24px 24px 0' }}>
          <FormStats formId={id} />
        </div>
      )}
      <SubmissionsPage formId={id} onBack={() => navigate('/forms')} />
    </>
  );
}
