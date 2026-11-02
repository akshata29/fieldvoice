import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import { http } from '@/api/http';
import { App } from '@/App';
import { AppProviders } from '@/app/Providers';
import { ROUTER_MODE, USE_MOCKS } from '@/lib/env';
import './index.css';

async function bootstrap(): Promise<void> {
  if (USE_MOCKS) {
    // Dynamic import: the fixtures and the in-memory backend never ship in a normal production build.
    const { installMocks } = await import('@/mocks/install');
    installMocks(http);
  }

  const Router = ROUTER_MODE === 'browser' ? BrowserRouter : HashRouter;
  const container = document.getElementById('root');
  if (!container) throw new Error('#root element not found');
  createRoot(container).render(
    <StrictMode>
      <AppProviders>
        <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <App />
        </Router>
      </AppProviders>
    </StrictMode>,
  );
}

void bootstrap();
