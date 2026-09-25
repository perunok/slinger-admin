import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';
import OverviewPage from './OverviewPage.svelte';
import { session } from '../lib/state/session.svelte';
import { stubApi, user } from '../test/helpers';

const stats = { users: 3, platform_admins: 1, disabled_users: 0, workspaces: 2, memberships: 4, pending_invites: 0, pending_join_requests: 0, collections: 0, requests: 0, environments: 0, active_sessions: 1, audit_logs: 5 };
const page = { items: [], page: { next_cursor: null, has_more: false } };

function setup(health: { status?: number; json?: unknown; text?: string }) {
  session.user = user({ platform_role: 'super_admin' });
  stubApi((r) => {
    if (r.path === '/admin/health') return health;
    if (r.path === '/admin/stats') return { json: stats };
    if (r.path === '/admin/audit-logs') return { json: page };
  });
  render(OverviewPage);
}

describe('platform health card', () => {
  it('healthy: shows Ok and the service list', async () => {
    setup({ json: { status: 'ok', services: { api: 'ok', postgres: 'ok' }, timestamp: new Date().toISOString() } });
    const card = (await screen.findByText('Platform health')).closest('.card')!;
    expect(await within(card as HTMLElement).findByText('Ok')).toBeInTheDocument();
    expect(screen.getByText('postgres')).toBeInTheDocument();
  });

  it('503 with a valid body shows the degraded per-service breakdown, not "server unavailable"', async () => {
    setup({ status: 503, json: { status: 'degraded', services: { api: 'ok', postgres: 'down' }, timestamp: new Date().toISOString() } });
    const card = (await screen.findByText('Platform health')).closest('.card')! as HTMLElement;
    expect(await within(card).findByText('Degraded')).toBeInTheDocument();
    expect(within(card).getByRole('alert')).toHaveTextContent('postgres: down');
    const services = screen.getByRole('heading', { name: 'Services' }).closest('section')! as HTMLElement;
    expect(within(services.querySelector('li:nth-child(2)') as HTMLElement).getByText('Down')).toBeInTheDocument();
    expect(within(services.querySelector('li:nth-child(1)') as HTMLElement).getByText('Ok')).toBeInTheDocument();
    expect(screen.queryByText(/temporarily unavailable/i)).toBeNull();
  });

  it('503 without a usable body (proxy error page) is still the generic unavailable message with retry', async () => {
    setup({ status: 503, text: '<html>Service Unavailable</html>' });
    const card = (await screen.findByText('Platform health')).closest('.card')! as HTMLElement;
    expect(await within(card).findByText(/temporarily unavailable/i)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
