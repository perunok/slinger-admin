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

  it('owner removes a host after confirming; the row disappears and the API is called', async () => {
    session.user = user({ platform_role: 'user' });
    const active = { ...pending, status: 'active', tls_status: 'ready' };
    const calls = stubApi((r) => {
      if (r.method === 'GET') return { json: { items: [active, { ...pending, id: 'h2', host: 'other.acme.com' }] } };
      if (r.method === 'DELETE' && r.path === '/workspaces/w1/hosts/h1') return { json: { ok: true } };
    });
    render(WsHosts, { props: { id: 'w1', role: 'owner' } });
    const ev = userEvent.setup();
    await ev.click(await screen.findByRole('button', { name: 'Remove host api.acme.com' }));
    const dlg = await screen.findByRole('dialog', { hidden: true });
    expect(within(dlg).getByText(/stop resolving to this workspace/i)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false); // nothing before confirming
    await ev.click(within(dlg).getByRole('button', { name: 'Remove host', hidden: true }));
    await waitFor(() => expect(screen.queryByText('api.acme.com')).toBeNull());
    expect(screen.getByText('other.acme.com')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/workspaces/w1/hosts/h1']);
    expect(toasts.items.some((t) => /Removed api.acme.com/.test(t.message))).toBe(true);
  });

  it('cancelling the confirmation removes nothing; a server error stays in the dialog and the row stays', async () => {
    session.user = user({ platform_role: 'user' });
    stubApi((r) => {
      if (r.method === 'GET') return { json: { items: [pending] } };
      if (r.method === 'DELETE') return { status: 404, json: { error: { code: 'not_found', message: 'host not found' } } };
    });
    render(WsHosts, { props: { id: 'w1', role: 'owner' } });
    const ev = userEvent.setup();
    await ev.click(await screen.findByRole('button', { name: 'Remove host api.acme.com' }));
    await ev.click(within(await screen.findByRole('dialog', { hidden: true })).getByRole('button', { name: 'Cancel', hidden: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await ev.click(screen.getByRole('button', { name: 'Remove host api.acme.com' }));
    await ev.click(within(await screen.findByRole('dialog', { hidden: true })).getByRole('button', { name: 'Remove host', hidden: true }));
    expect(await screen.findByText('host not found')).toBeInTheDocument();
    expect(screen.getAllByRole('row', { name: /api.acme.com/ }).length).toBeGreaterThan(0);
  });

  it('non-owners see no Remove button; platform admins do', async () => {
    session.user = user({ platform_role: 'user' });
    stubApi(() => ({ json: { items: [pending] } }));
    const { unmount } = render(WsHosts, { props: { id: 'w1', role: 'admin' } });
    await screen.findByText('api.acme.com');
    expect(screen.queryByRole('button', { name: /remove host/i })).toBeNull();
    unmount();
    session.user = user({ platform_role: 'platform_admin' });
    render(WsHosts, { props: { id: 'w1', role: null } });
    expect(await screen.findByRole('button', { name: 'Remove host api.acme.com' })).toBeInTheDocument();
  });
});
