import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { client, loadApiConfig } from './lib/api';
import { theme } from './lib/state/theme.svelte';

async function start() {
  theme.init();
  const config = loadApiConfig();
  if (config.ok) {
    client.configure({ baseUrl: config.baseUrl });
    if (import.meta.env.VITE_MOCK_API === '1') {
      // Dead-code eliminated from production builds (the flag is a build-time constant).
      const { installMockApi } = await import('./dev/mockApi');
      installMockApi(client);
    }
  }
  mount(App, { target: document.getElementById('app')!, props: { config } });
}

void start();
