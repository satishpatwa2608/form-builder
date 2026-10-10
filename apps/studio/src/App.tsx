import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { PublicOnly, RequireAuth } from './components/AppShell';
import { useAuth } from './lib/auth';
import AccessPage from './pages/AccessPage';
import AccountPage from './pages/AccountPage';
import AuditPage from './pages/AuditPage';
import LogsPage from './pages/LogsPage';
import CustomersPage from './pages/CustomersPage';
import ConnectorsPage from './pages/ConnectorsPage';
import FormsPage from './pages/FormsPage';
import MembersPage from './pages/MembersPage';
import OverviewPage from './pages/OverviewPage';
import SettingsPage from './pages/SettingsPage';
import LoginPage from './pages/auth/LoginPage';
import SignupPage from './pages/auth/SignupPage';
import { AnswerApprovalPage } from './pages/auth/AnswerApprovalPage';
import { AcceptInvitePage, ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage } from './pages/auth/TokenPages';

/** The builder is most of the bundle: load it only when a form is opened. */
const BuilderRoute = lazy(() => import('./pages/BuilderRoute'));
// The ported work pages are big too: one lazy chunk for all of them.
const work = () => import('./pages/WorkRoutes');
const InboxRoute = lazy(() => work().then((m) => ({ default: m.InboxRoute })));
const DashboardRoute = lazy(() => work().then((m) => ({ default: m.DashboardRoute })));
const NewWorkItemRoute = lazy(() => work().then((m) => ({ default: m.NewWorkItemRoute })));
const WorkingTimeRoute = lazy(() => work().then((m) => ({ default: m.WorkingTimeRoute })));
const WebhooksRoute = lazy(() => work().then((m) => ({ default: m.WebhooksRoute })));
const WorkflowsRoute = lazy(() => work().then((m) => ({ default: m.WorkflowsRoute })));
const StylesRoute = lazy(() => work().then((m) => ({ default: m.StylesRoute })));
const FragmentsRoute = lazy(() => work().then((m) => ({ default: m.FragmentsRoute })));
const ListsRoute = lazy(() => work().then((m) => ({ default: m.ListsRoute })));
const EmailTemplatesRoute = lazy(() => work().then((m) => ({ default: m.EmailTemplatesRoute })));
const ExtensionsRoute = lazy(() => work().then((m) => ({ default: m.ExtensionsRoute })));
const SubmissionsRoute = lazy(() => work().then((m) => ({ default: m.SubmissionsRoute })));
const lazyPage = (el: JSX.Element) => <Suspense fallback={<p className="st-empty">Loading…</p>}>{el}</Suspense>;

/** Back from the identity provider: the refresh cookie is set, the auth provider has picked it up. */
function SsoComplete() {
  const { status } = useAuth();
  if (status === 'loading') return <p className="st-empty">Signing you in…</p>;
  return <Navigate to={status === 'signedIn' ? '/' : `/login?sso_error=${encodeURIComponent('Single sign-on did not complete. Please try again.')}`} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<PublicOnly><LoginPage /></PublicOnly>} />
      <Route path="/signup" element={<PublicOnly><SignupPage /></PublicOnly>} />
      <Route path="/forgot-password" element={<PublicOnly><ForgotPasswordPage /></PublicOnly>} />
      {/* Links from emails work whether or not someone is signed in. */}
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/accept-invite" element={<AcceptInvitePage />} />
      <Route path="/answer" element={<AnswerApprovalPage />} />
      <Route path="/sso/complete" element={<SsoComplete />} />
      <Route element={<RequireAuth />}>
        <Route index element={<OverviewPage />} />
        <Route path="forms" element={<FormsPage />} />
        <Route path="fragments" element={lazyPage(<FragmentsRoute />)} />
        <Route path="lists" element={lazyPage(<ListsRoute />)} />
        <Route path="email-templates" element={lazyPage(<EmailTemplatesRoute />)} />
        <Route path="workflows" element={lazyPage(<WorkflowsRoute />)} />
        <Route path="styles" element={lazyPage(<StylesRoute />)} />
        <Route path="connectors" element={<ConnectorsPage />} />
        <Route path="members" element={<MembersPage />} />
        <Route path="access" element={<AccessPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="customers" element={<CustomersPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="work" element={lazyPage(<InboxRoute />)} />
        <Route path="work/dashboard" element={lazyPage(<DashboardRoute />)} />
        <Route path="work/new" element={lazyPage(<NewWorkItemRoute />)} />
        <Route path="settings/working-time" element={lazyPage(<WorkingTimeRoute />)} />
        <Route path="settings/extensions" element={lazyPage(<ExtensionsRoute />)} />
        <Route path="settings/webhooks" element={lazyPage(<WebhooksRoute />)} />
        <Route path="forms/:id/submissions" element={lazyPage(<SubmissionsRoute />)} />
      </Route>
      <Route element={<RequireAuth bare />}>
        <Route
          path="forms/:id/edit"
          element={
            <Suspense fallback={<p className="st-empty">Opening the builder…</p>}>
              <BuilderRoute />
            </Suspense>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
