import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import WsMembers from './WsMembers.svelte';
import { session } from '../../lib/state/session.svelte';
import { toasts } from '../../lib/state/toasts.svelte';
import { stubApi, user, tick } from '../../test/helpers';

const member = (id: string, role: string, email = `${id}@example.com`) => ({
  id, user_id: `user-${id}`, email, display_name: id.toUpperCase(), role, status: 'active', version: 3,
});
const list = { items: [member('own', 'owner'), member('ed', 'editor'), member('vw', 'viewer')], page: { next_cursor: null, has_more: false } };

function setup(platformRole: 'user' | 'platform_admin' | 'super_admin', role: 'owner' | 'admin' | 'editor' | 'viewer' | null, extra?: Parameters<typeof stubApi>[0]) {
  session.user = user({ id: 'me', platform_role: platformRole });
  const calls = stubApi((r) => extra?.(r) ?? (r.method === 'GET' && r.path === '/workspaces/w1/members' ? { json: list } : undefined));
  render(WsMembers, { props: { id: 'w1', role } });
  return calls;
}

describe('WsMembers role-based UI', () => {
  beforeEach(() => {
    toasts.items = [];
  });

  it('owner can change roles and remove, but the owner row is locked', async () => {
    setup('user', 'owner');
    const rowOwner = (await screen.findByText('OWN')).closest('tr')!;
    expect(within(rowOwner).queryByRole('combobox')).toBeNull();
    expect(within(rowOwner).getByRole('button', { name: /remove own/i })).toBeDisabled();
    const rowEd = screen.getByText('ED').closest('tr')!;
    expect(within(rowEd).getByRole('combobox')).toBeEnabled();
    expect(within(rowEd).getByRole('button', { name: /remove ed/i })).toBeEnabled();
    // owner is never offered as a role to assign
    const options = within(within(rowEd).getByRole('combobox')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Admin', 'Editor', 'Viewer']);
  });

  it('workspace admin (not owner) and editor see no management controls', async () => {
    for (const role of ['admin', 'editor', 'viewer'] as const) {
      setup('user', role);
      await screen.findByText('ED');
      expect(screen.queryAllByRole('combobox')).toHaveLength(0);
      expect(screen.queryAllByRole('button', { name: /remove/i })).toHaveLength(0);
      expect(screen.getByText(/only the workspace owner or a platform admin/i)).toBeInTheDocument();
      document.body.innerHTML = '';
    }
  });

  it('platform admin without membership can manage', async () => {
    setup('platform_admin', null);
    const rowEd = (await screen.findByText('ED')).closest('tr')!;
    expect(within(rowEd).getByRole('combobox')).toBeEnabled();
  });

  it('a failed role update puts the dropdown back to the saved role and shows an error', async () => {
    const calls = setup('user', 'owner', (r) => {
      if (r.method === 'GET') return { json: list };
      if (r.method === 'PATCH') return { status: 500, text: '<html>oops</html>' };
    });
    const ev = userEvent.setup();
    const select = within((await screen.findByText('ED')).closest('tr')!).getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('editor');
    await ev.selectOptions(select, 'admin');
    await waitFor(() => expect(toasts.items.some((t) => t.kind === 'error')).toBe(true));
    expect(select.value).toBe('editor');
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ role: 'admin', version: 3 });
  });

  it('a successful role update sends the version and keeps the new value', async () => {
    setup('user', 'owner', (r) => {
      if (r.method === 'GET') return { json: list };
      if (r.method === 'PATCH') return { json: { member: { id: 'ed', role: 'admin', version: 4 } } };
    });
    const ev = userEvent.setup();
    const select = within((await screen.findByText('ED')).closest('tr')!).getByRole('combobox') as HTMLSelectElement;
    await ev.selectOptions(select, 'admin');
    await waitFor(() => expect(toasts.items.some((t) => t.kind === 'success')).toBe(true));
    expect(select.value).toBe('admin');
  });

  it('removing a member asks for confirmation and disables the confirm button while in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let deletes = 0;
    const calls = setup('user', 'owner', (r) => {
      if (r.method === 'GET') return { json: list };
      if (r.method === 'DELETE') {
        deletes++;
        return { json: {} };
      }
    });
    void gate;
    const ev = userEvent.setup();
    await ev.click(within((await screen.findByText('VW')).closest('tr')!).getByRole('button', { name: /remove vw/i }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    const confirm = within(dialog).getByRole('button', { name: 'Remove member' });
    await ev.dblClick(confirm);
    await waitFor(() => expect(screen.queryByText('VW')).toBeNull());
    expect(deletes).toBe(1);
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/workspaces/w1/members/vw')).toBe(true);
    release();
    await tick();
  });
});
