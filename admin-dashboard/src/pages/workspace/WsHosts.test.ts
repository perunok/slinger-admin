import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import WsHosts from './WsHosts.svelte';
import { toasts } from '../../lib/state/toasts.svelte';
import { session } from '../../lib/state/session.svelte';
import { stubApi, user } from '../../test/helpers';

const pending = { id: 'h1', host: 'api.acme.com', kind: 'custom_domain', status: 'pending_verification', tls_status: 'pending', version: 1 };
const verification = { dns_record_type: 'TXT', dns_record_name: '_slinger-verify.api.acme.com', dns_record_value: 'verify-123' };

describe('WsHosts', () => {
  it('shows the TXT record name/value with copy buttons after adding a custom domain', async () => {
    session.user = user({ platform_role: 'user' });
    stubApi((r) => {
      if (r.method === 'GET') return { json: { items: [] } };
      if (r.method === 'POST') return { status: 201, json: { host: pending, verification } };
    });
    render(WsHosts, { props: { id: 'w1', role: 'owner' } });
    const ev = userEvent.setup();
    await ev.click(await screen.findByRole('button', { name: 'Add host' }));
    await ev.type(screen.getByLabelText('Hostname'), 'api.acme.com');
    await ev.click(document.querySelector('button[type=submit][form=host-form]')!);
    const panel = await screen.findByLabelText(/dns verification for api.acme.com/i);
    expect(within(panel).getByText('_slinger-verify.api.acme.com')).toBeInTheDocument();
    expect(within(panel).getByText('verify-123')).toBeInTheDocument();
    await ev.click(within(panel).getByRole('button', { name: /copy value/i }));
    expect(await navigator.clipboard.readText()).toBe('verify-123');
  });

  it('Re-check DNS calls verify and updates the status', async () => {
    session.user = user({ platform_role: 'user' });
    const calls = stubApi((r) => {
      if (r.method === 'GET') return { json: { items: [{ ...pending, verification }] } };
      if (r.path === '/workspaces/w1/hosts/h1/verify') return { json: { host: { ...pending, status: 'active', tls_status: 'ready' }, verified: true } };
    });
    render(WsHosts, { props: { id: 'w1', role: 'owner' } });
    const ev = userEvent.setup();
    await screen.findByText('verify-123'); // instructions survive a reload via the list payload
    await ev.click(screen.getByRole('button', { name: /re-check dns for api.acme.com/i }));
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());
    expect(calls.some((c) => c.method === 'POST' && c.path === '/workspaces/w1/hosts/h1/verify')).toBe(true);
    expect(screen.queryByText('verify-123')).toBeNull();
  });

  it('Re-check DNS with a missing record keeps the pending row and its TXT instructions', async () => {
    session.user = user({ platform_role: 'user' });
    stubApi((r) => {
      if (r.method === 'GET') return { json: { items: [{ ...pending, verification }] } };
      if (r.path === '/workspaces/w1/hosts/h1/verify') return { json: { host: pending, verified: false } };
    });
    render(WsHosts, { props: { id: 'w1', role: 'owner' } });
    const ev = userEvent.setup();
    await screen.findByText('verify-123');
    await ev.click(screen.getByRole('button', { name: /re-check dns for api.acme.com/i }));
    await waitFor(() => expect(toasts.items.some((t) => /DNS record not found yet/i.test(t.message))).toBe(true));
    expect(screen.getByText('verify-123')).toBeInTheDocument();
  });

  it('non-owners cannot add hosts or re-check', async () => {
    session.user = user({ platform_role: 'user' });
    stubApi(() => ({ json: { items: [{ ...pending, verification }] } }));
    render(WsHosts, { props: { id: 'w1', role: 'admin' } });
    await screen.findByText('verify-123');
    expect(screen.queryByRole('button', { name: 'Add host' })).toBeNull();
    expect(screen.queryByRole('button', { name: /re-check/i })).toBeNull();
  });
});
