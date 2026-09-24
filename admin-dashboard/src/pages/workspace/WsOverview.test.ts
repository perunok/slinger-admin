import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import WsOverview from './WsOverview.svelte';
import { session } from '../../lib/state/session.svelte';
import { toasts } from '../../lib/state/toasts.svelte';
import { stubApi, user } from '../../test/helpers';
import type { Workspace } from '../../lib/api/schemas';

const ws: Workspace = {
  id: 'w1', slug: 'acme', name: 'Acme', description: 'Team space', visibility: 'private', default_role_for_requests: 'viewer',
  host_mode: 'shared', version: 4, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
};

describe('workspace settings form', () => {
  it('is offered to the owner and to platform admins only', () => {
    for (const [platform, role, shown] of [
      ['user', 'owner', true], ['platform_admin', null, true], ['super_admin', null, true],
      ['user', 'admin', false], ['user', 'editor', false], ['user', 'viewer', false],
    ] as const) {
      session.user = user({ platform_role: platform });
      const { unmount } = render(WsOverview, { props: { workspace: ws, role } });
      expect(!!screen.queryByRole('heading', { name: 'Settings' }), `${platform}/${role}`).toBe(shown);
      unmount();
    }
  });

  it('sends only the changed fields with the loaded version, and applies the server copy', async () => {
    session.user = user({ platform_role: 'user' });
    const updated = { ...ws, name: 'Acme Platform', visibility: 'internal', version: 5 };
    const calls = stubApi((r) => (r.method === 'PATCH' && r.path === '/workspaces/w1' ? { json: { workspace: updated } } : undefined));
    const onupdate = vi.fn();
    render(WsOverview, { props: { workspace: ws, role: 'owner', onupdate } });
    const ev = userEvent.setup();
    const save = screen.getByRole('button', { name: 'Save settings' });
    expect(save).toBeDisabled(); // nothing changed yet
    await ev.clear(screen.getByLabelText('Name'));
    await ev.type(screen.getByLabelText('Name'), 'Acme Platform');
    await ev.selectOptions(screen.getByLabelText('Visibility'), 'internal');
    await ev.click(save);
    await waitFor(() => expect(onupdate).toHaveBeenCalledWith(updated));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ name: 'Acme Platform', visibility: 'internal', version: 4 });
    expect(toasts.items.some((t) => /settings saved/i.test(t.message))).toBe(true);
  });

  it('validates the name client-side and sends nothing', async () => {
    session.user = user({ platform_role: 'user' });
    const calls = stubApi(() => ({ json: {} }));
    render(WsOverview, { props: { workspace: ws, role: 'owner' } });
    const ev = userEvent.setup();
    await ev.clear(screen.getByLabelText('Name'));
    await ev.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Name is required.')).toBeInTheDocument();
    expect(calls.length).toBe(0);
  });

  it('a stale version shows the conflict message; "Load latest version" reloads and resets the form', async () => {
    session.user = user({ platform_role: 'user' });
    stubApi(() => ({
      status: 409,
      json: { error: { code: 'version_mismatch', message: 'resource was modified by someone else', details: { current_version: 7 } } },
    }));
    let current = ws;
    const onreload = vi.fn(async () => {
      current = { ...ws, name: 'Renamed elsewhere', version: 7 };
      await view.rerender({ workspace: current, role: 'owner', onreload });
    });
    const view = render(WsOverview, { props: { workspace: current, role: 'owner', onreload } });
    const ev = userEvent.setup();
    await ev.clear(screen.getByLabelText('Name'));
    await ev.type(screen.getByLabelText('Name'), 'My edit');
    await ev.click(screen.getByRole('button', { name: 'Save settings' }));
    const alert = await screen.findByTestId('version-conflict');
    expect(alert).toHaveTextContent(/Someone else changed this workspace/);
    expect(alert).toHaveTextContent(/version 7/);
    expect(screen.getByLabelText('Name')).toHaveValue('My edit'); // the user's edit is not thrown away silently
    await ev.click(screen.getByRole('button', { name: 'Load latest version' }));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Renamed elsewhere'));
    expect(onreload).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('version-conflict')).toBeNull();
  });

  it('other server errors are shown in the form', async () => {
    session.user = user({ platform_role: 'user' });
    stubApi(() => ({ status: 403, json: { error: { code: 'workspace_access_denied', message: 'You do not have access to this workspace.' } } }));
    render(WsOverview, { props: { workspace: ws, role: 'owner' } });
    const ev = userEvent.setup();
    await ev.type(screen.getByLabelText('Name'), ' 2');
    await ev.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('You do not have access to this workspace.')).toBeInTheDocument();
  });
});
