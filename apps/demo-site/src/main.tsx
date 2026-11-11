import { createBrowserClient } from '@ff/sdk-client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, FIRST_VISITOR } from './App';
import { API_URL, BACKEND_URL, DASHBOARD_URL } from './config';
import { takeKeysFromUrl } from './keys';
import { createPriceSource } from './price';
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
      context: { ...FIRST_VISITOR },
    })
  : null;
const priceSource = keys
  ? createPriceSource({ baseUrl: BACKEND_URL, serverKey: keys.server })
  : undefined;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App client={client} dashboardUrl={DASHBOARD_URL} priceSource={priceSource} />
  </StrictMode>,
);
