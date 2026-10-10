import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fb/ui/tokens.css';
import '@form/styles/tailwind.css';
import '@form/styles/form-builder.css';
import '@form/styles/public-form.css';
import './runtime.css';
import App from './App';
import SignPage, { parseSignPath } from './SignPage';
import PortalPage, { parsePortalPath } from './PortalPage';
import PayPage, { parsePayPath } from './PayPage';
import { setCodeConfirmer } from '@form/adapters/codes/code-confirmer';
import { httpCodeConfirmer } from './adapters';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

// A signer's link (/sign/…) opens the signing page; everything else is a form.
const signToken = parseSignPath(window.location.pathname);
// The requests portal (/portal/…) is the third page this app has.
const portal = parsePortalPath(window.location.pathname);

// Where a person lands after paying for a response (/pay/…).
const pay = parsePayPath(window.location.pathname, window.location.search);
// Codes that confirm an email address or phone number are sent and checked by the server.
setCodeConfirmer(httpCodeConfirmer);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {signToken ? <SignPage token={signToken} /> : portal ? <PortalPage org={portal.org} /> : pay ? <PayPage {...pay} /> : <App />}
    </QueryClientProvider>
  </StrictMode>,
);
