import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import WsInvites from './WsInvites.svelte';
import { session } from '../../lib/state/session.svelte';
import { stubApi, user } from '../../test/helpers';

const invite = { id: 'inv-1', workspace_id: 'w1', email: 'bob@example.com', role: 'viewer', status: 'pending', invited_by_user_id: 'u1', expires_at: '2030-01-01T00:00:00.000Z', version: 1 };

describe('WsInvites', () => {
  it('shows the one-time token AND the invite id (both are needed to accept via POST /v1/invites/{id}/accept)', async () => {
    session.user = user({ platform_role: 'user' });
    const calls = stubApi((r) => {
      if (r.method === 'GET') return { json: { items: [], page: { next_cursor: null, has_more: false } } };
      if (r.method === 'POST') return { status: 201, json: { invite, invite_token: 'tok-abcdefghijklmnop' } };
    });
    render(WsInvites, { props: { id: 'w1', role: 'owner' } });
    const ev = userEvent.setup();
    await ev.click(await screen.findByRole('button', { name: 'Invite member' }));
    await ev.type(screen.getByLabelText('Email'), 'bob@example.com');
    await ev.click(document.querySelector('button[type=submit][form=invite-form]')!);
    expect((await screen.findByTestId('invite-token')).textContent).toBe('tok-abcdefghijklmnop');
    expect(screen.getByTestId('invite-id').textContent).toBe('inv-1');
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.path).toBe('/workspaces/w1/invites');
    expect(post.body).toEqual({ email: 'bob@example.com', role: 'viewer' });
  });
});
