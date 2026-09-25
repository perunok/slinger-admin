import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import WsJoinRequests from './WsJoinRequests.svelte';
import { session } from '../../lib/state/session.svelte';
import { toasts } from '../../lib/state/toasts.svelte';
import { stubApi, user } from '../../test/helpers';

const jr = (id: string, status = 'pending') => ({
  id, requester_user_id: `u-${id}`, requester_email: `${id}@example.com`, requester_display_name: id.toUpperCase(),
  message: 'let me in', status, requested_role: 'viewer', version: 2,
});

describe('WsJoinRequests', () => {
  beforeEach(() => (toasts.items = []));

  it('offers Approve (with role choice) and Reject; approval sends the chosen role and version once', async () => {
    session.user = user({ platform_role: 'user' });
    let approvals = 0;
    const calls = stubApi((r) => {
      if (r.method === 'GET') return { json: { items: [jr('a')], page: { next_cursor: null, has_more: false } } };
      if (r.path.endsWith('/approve')) {
        approvals++;
        return { json: { membership: { id: 'm', role: 'editor' } } };
      }
    });
    render(WsJoinRequests, { props: { id: 'w1', role: 'admin' } });
    const ev = userEvent.setup();
    const row = (await screen.findByText('A')).closest('tr')!;
    expect(within(row).getByRole('button', { name: /reject a/i })).toBeEnabled();
    await ev.selectOptions(within(row).getByRole('combobox'), 'editor');
    await ev.dblClick(within(row).getByRole('button', { name: /approve a/i }));
    await waitFor(() => expect(within(screen.getByText('A').closest('tr')!).getByText('Approved')).toBeInTheDocument());
    expect(approvals).toBe(1);
    const call = calls.find((c) => c.path.endsWith('/approve'))!;
    expect(call.path).toBe('/workspaces/w1/join-requests/a/approve');
    expect(call.body).toEqual({ role: 'editor', version: 2 });
    expect(within(screen.getByText('A').closest('tr')!).queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('is read-only for roles that cannot moderate', async () => {
    session.user = user({ platform_role: 'user' });
    stubApi(() => ({ json: { items: [jr('a')], page: { next_cursor: null, has_more: false } } }));
    render(WsJoinRequests, { props: { id: 'w1', role: 'editor' } });
    const row = (await screen.findByText('A')).closest('tr')!;
    expect(within(row).getByRole('button', { name: /approve a/i })).toBeDisabled();
    expect(within(row).getByRole('button', { name: /reject a/i })).toBeDisabled();
  });

  it('paginates with Load more using the cursor', async () => {
    session.user = user({ platform_role: 'platform_admin' });
    const calls = stubApi((r) =>
      r.query.get('cursor') === 'c2'
        ? { json: { items: [jr('b')], page: { next_cursor: null, has_more: false } } }
        : { json: { items: [jr('a')], page: { next_cursor: 'c2', has_more: true } } },
    );
    render(WsJoinRequests, { props: { id: 'w1', role: null } });
    const ev = userEvent.setup();
    await ev.click(await screen.findByRole('button', { name: 'Load more' }));
    await screen.findByText('B');
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(calls.at(-1)!.query.get('cursor')).toBe('c2');
  });
});
