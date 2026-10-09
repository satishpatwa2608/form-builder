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

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

// A signer's link (/sign/…) opens the signing page; everything else is a form.
const signToken = parseSignPath(window.location.pathname);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {signToken ? <SignPage token={signToken} /> : <App />}
    </QueryClientProvider>
  </StrictMode>,
);
