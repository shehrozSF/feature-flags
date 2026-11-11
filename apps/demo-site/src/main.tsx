import { createBrowserClient } from '@ff/sdk-client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { API_URL, DASHBOARD_URL } from './config';
import { takeKeysFromUrl } from './keys';
import './tokens.css';

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const keys = takeKeysFromUrl(window.location, window.history, browserStorage());
// The visitor starts anonymous (the SDK adds a remembered id) in the US on the
// free plan; "Act as a visitor" changes that with identify().
const client = keys
  ? createBrowserClient({
      clientKey: keys.client,
      baseUrl: API_URL,
      context: { country: 'US', plan: 'free' },
    })
  : null;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App client={client} dashboardUrl={DASHBOARD_URL} />
  </StrictMode>,
);
