import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import UsersPage from './UsersPage.svelte';
import { session } from '../lib/state/session.svelte';
import { stubApi, user } from '../test/helpers';

const users = {
  items: [user({ id: 'me', email: 'me@example.com', display_name: 'Me', platform_role: 'super_admin' }), user({ id: 'u2', email: 'two@example.com', display_name: 'Two' })],
  page: { next_cursor: null, has_more: false },
};

describe('UsersPage role-based UI', () => {
  it('super admin can change platform roles (not their own) and create admins (never another super admin)', async () => {
    session.user = user({ id: 'me', platform_role: 'super_admin' });
    stubApi(() => ({ json: users }));
    render(UsersPage);
    const row = (await screen.findByText('Two')).closest('tr')!;
    expect(within(row).getByRole('combobox')).toBeEnabled();
    expect(within((await screen.findByText('Me')).closest('tr')!).queryByRole('combobox')).toBeNull();
    const ev = userEvent.setup();
    await ev.click(screen.getByRole('button', { name: 'Create user' }));
    const opts = within(await screen.findByLabelText('Platform role')).getAllByRole('option').map((o) => o.textContent);
    expect(opts).toEqual(['User', 'Platform admin']);
  });

  it('platform admin cannot change roles and can only create plain users', async () => {
    session.user = user({ id: 'me', platform_role: 'platform_admin' });
    stubApi(() => ({ json: users }));
    render(UsersPage);
    await screen.findByText('Two');
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    const ev = userEvent.setup();
    await ev.click(screen.getByRole('button', { name: 'Create user' }));
    const opts = within(await screen.findByLabelText('Platform role')).getAllByRole('option').map((o) => o.textContent);
    expect(opts).toEqual(['User']);
  });

  it('create form validates client-side and sends nothing when invalid', async () => {
    session.user = user({ id: 'me', platform_role: 'super_admin' });
    const calls = stubApi(() => ({ json: users }));
    render(UsersPage);
    await screen.findByText('Two');
    const ev = userEvent.setup();
    await ev.click(screen.getByRole('button', { name: 'Create user' }));
    await ev.click(within(screen.getByRole('dialog', { hidden: true })).getByRole('button', { name: 'Create user', hidden: true }));
    expect(await screen.findByText('Email is required.')).toBeInTheDocument();
    expect(screen.getByText('Display name is required.')).toBeInTheDocument();
    expect(screen.getByText('Password is required.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
});
