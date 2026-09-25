import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import UsersPage from './UsersPage.svelte';
import { session } from '../lib/state/session.svelte';
import { stubApi, user } from '../test/helpers';
import { toasts } from '../lib/state/toasts.svelte';

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
    await ev.click(screen.getByLabelText('Set a password manually'));
    await ev.click(within(screen.getByRole('dialog', { hidden: true })).getByRole('button', { name: 'Create user', hidden: true }));
    expect(await screen.findByText('Email is required.')).toBeInTheDocument();
    expect(screen.getByText('Display name is required.')).toBeInTheDocument();
    expect(screen.getByText('Password is required.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  const adminUsers = (over: Record<string, unknown> = {}) => ({
    items: [
      user({ id: 'me', email: 'me@example.com', display_name: 'Me', platform_role: 'super_admin' }),
      user({ id: 'pa', email: 'pa@example.com', display_name: 'Pat Admin', platform_role: 'platform_admin' }),
      user({ id: 'u2', email: 'two@example.com', display_name: 'Two', disabled: false, ...over }),
      user({ id: 'u3', email: 'three@example.com', display_name: 'Three', disabled: true }),
    ],
    page: { next_cursor: null, has_more: false },
  });

  describe('generated temporary password', () => {
    it('is the default: nothing to type, the password is shown once with a copy button and gone after closing', async () => {
      session.user = user({ id: 'me', platform_role: 'super_admin' });
      const calls = stubApi((r) => {
        if (r.method === 'GET') return { json: adminUsers() };
        if (r.method === 'POST' && r.path === '/admin/users')
          return { status: 201, json: { user: user({ id: 'new', email: 'new@example.com', display_name: 'New', disabled: false }), temporary_password: 'Tmp-Secret-abc123XYZ' } };
      });
      render(UsersPage);
      await screen.findByText('Two');
      const ev = userEvent.setup();
      await ev.click(screen.getByRole('button', { name: 'Create user' }));
      expect(screen.queryByLabelText('Initial password')).toBeNull();
      expect(screen.getByLabelText('Generate a temporary password')).toBeChecked();
      await ev.type(screen.getByLabelText('Email'), 'new@example.com');
      await ev.type(screen.getByLabelText('Display name'), 'New');
      await ev.click(within(screen.getByRole('dialog', { hidden: true })).getByRole('button', { name: 'Create user', hidden: true }));
      const box = await screen.findByTestId('temp-password');
      expect(within(box).getByLabelText('Temporary password')).toHaveTextContent('Tmp-Secret-abc123XYZ');
      // no password was sent, so the server generated it
      const post = calls.find((c) => c.method === 'POST')!;
      expect(post.body).toEqual({ email: 'new@example.com', display_name: 'New', platform_role: 'user' });
      // copy button copies the secret but does not leak it into its accessible name
      const copy = within(box).getByRole('button', { name: 'Copy password' });
      await ev.click(copy);
      expect(await navigator.clipboard.readText()).toBe('Tmp-Secret-abc123XYZ');
      // the new user is in the list already
      expect(screen.getAllByText('new@example.com').length).toBeGreaterThan(0);
      await ev.click(screen.getByRole('button', { name: 'Done', hidden: true }));
      await waitFor(() => expect(screen.queryByText('Tmp-Secret-abc123XYZ')).toBeNull());
      // opening the dialog again does not show the old secret
      await ev.click(screen.getByRole('button', { name: 'Create user' }));
      expect(screen.queryByText('Tmp-Secret-abc123XYZ')).toBeNull();
    });

    it('manual mode sends the typed password and shows no generated one', async () => {
      session.user = user({ id: 'me', platform_role: 'super_admin' });
      const calls = stubApi((r) => {
        if (r.method === 'GET') return { json: adminUsers() };
        if (r.method === 'POST') return { status: 201, json: { user: user({ id: 'new', email: 'm@example.com', display_name: 'M', disabled: false }), temporary_password: null } };
      });
      render(UsersPage);
      await screen.findByText('Two');
      const ev = userEvent.setup();
      await ev.click(screen.getByRole('button', { name: 'Create user' }));
      await ev.click(screen.getByLabelText('Set a password manually'));
      await ev.type(screen.getByLabelText('Email'), 'm@example.com');
      await ev.type(screen.getByLabelText('Display name'), 'M');
      await ev.type(screen.getByLabelText('Initial password'), 'short');
      await ev.click(within(screen.getByRole('dialog', { hidden: true })).getByRole('button', { name: 'Create user', hidden: true }));
      expect(await screen.findByText('Password must be at least 12 characters.')).toBeInTheDocument();
      await ev.clear(screen.getByLabelText('Initial password'));
      await ev.type(screen.getByLabelText('Initial password'), 'a-long-enough-password');
      await ev.click(within(screen.getByRole('dialog', { hidden: true })).getByRole('button', { name: 'Create user', hidden: true }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ email: 'm@example.com', password: 'a-long-enough-password' });
      expect(screen.queryByTestId('temp-password')).toBeNull();
    });
  });

  describe('disable / enable', () => {
    it('shows a Disabled badge, and Enable instead of Disable for disabled users', async () => {
      session.user = user({ id: 'me', platform_role: 'super_admin' });
      stubApi(() => ({ json: adminUsers() }));
      render(UsersPage);
      const row = (await screen.findByText('Three')).closest('tr')!;
      expect(within(row).getByText('Disabled')).toBeInTheDocument();
      expect(within(row).getByRole('button', { name: 'Enable three@example.com' })).toBeEnabled();
      expect(within(row).queryByRole('button', { name: /^Disable/ })).toBeNull();
    });

    it('disable asks for confirmation, then PATCHes {disabled:true} and shows the badge', async () => {
      session.user = user({ id: 'me', platform_role: 'platform_admin' });
      const calls = stubApi((r) => {
        if (r.method === 'GET') return { json: adminUsers() };
        if (r.method === 'PATCH') return { json: { user: user({ id: 'u2', email: 'two@example.com', display_name: 'Two', disabled: true }) } };
      });
      render(UsersPage);
      const ev = userEvent.setup();
      await ev.click(await screen.findByRole('button', { name: 'Disable two@example.com' }));
      const dlg = await screen.findByRole('dialog', { hidden: true });
      expect(within(dlg).getByText(/signed out everywhere/i)).toBeInTheDocument();
      expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
      await ev.click(within(dlg).getByRole('button', { name: 'Disable user', hidden: true }));
      await waitFor(() => expect(within(screen.getByText('Two').closest('tr')!).getByText('Disabled')).toBeInTheDocument());
      expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: '/admin/users/u2', body: { disabled: true } });
      expect(toasts.items.some((t) => /Disabled two@example.com/.test(t.message))).toBe(true);
    });

    it('enable confirms and PATCHes {disabled:false}', async () => {
      session.user = user({ id: 'me', platform_role: 'super_admin' });
      const calls = stubApi((r) => {
        if (r.method === 'GET') return { json: adminUsers() };
        if (r.method === 'PATCH') return { json: { user: user({ id: 'u3', email: 'three@example.com', display_name: 'Three', disabled: false }) } };
      });
      render(UsersPage);
      const ev = userEvent.setup();
      await ev.click(await screen.findByRole('button', { name: 'Enable three@example.com' }));
      await ev.click(within(await screen.findByRole('dialog', { hidden: true })).getByRole('button', { name: 'Enable user', hidden: true }));
      await waitFor(() => expect(within(screen.getByText('Three').closest('tr')!).queryByText('Disabled')).toBeNull());
      expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ disabled: false });
    });

    it('cannot disable yourself, the super admin or (as platform admin) another admin: the buttons are disabled with a reason', async () => {
      session.user = user({ id: 'pa', platform_role: 'platform_admin' });
      stubApi(() => ({ json: adminUsers() }));
      render(UsersPage);
      const own = (await screen.findByText('Pat Admin')).closest('tr')!;
      expect(within(own).getByRole('button', { name: 'Disable pa@example.com' })).toBeDisabled();
      expect(within(own).getByRole('button', { name: 'Disable pa@example.com' })).toHaveAttribute('title', 'You cannot disable your own account');
      const sa = screen.getByText('Me').closest('tr')!;
      expect(within(sa).getByRole('button', { name: 'Disable me@example.com' })).toBeDisabled();
      expect(within(sa).getByRole('button', { name: 'Disable me@example.com' })).toHaveAttribute('title', 'The super admin cannot be disabled');
      expect(within(screen.getByText('Two').closest('tr')!).getByRole('button', { name: 'Disable two@example.com' })).toBeEnabled();
    });

    it('a super admin may disable a platform admin', async () => {
      session.user = user({ id: 'me', platform_role: 'super_admin' });
      stubApi(() => ({ json: adminUsers() }));
      render(UsersPage);
      expect(await screen.findByRole('button', { name: 'Disable pa@example.com' })).toBeEnabled();
    });

    it("the server's refusal is surfaced in the dialog and the row is unchanged", async () => {
      session.user = user({ id: 'me', platform_role: 'platform_admin' });
      stubApi((r) => {
        if (r.method === 'GET') return { json: adminUsers() };
        if (r.method === 'PATCH') return { status: 403, json: { error: { code: 'forbidden', message: 'modifying a platform admin requires the super_admin role' } } };
      });
      render(UsersPage);
      const ev = userEvent.setup();
      await ev.click(await screen.findByRole('button', { name: 'Disable two@example.com' }));
      await ev.click(within(await screen.findByRole('dialog', { hidden: true })).getByRole('button', { name: 'Disable user', hidden: true }));
      expect(await screen.findByText('modifying a platform admin requires the super_admin role')).toBeInTheDocument();
      expect(within(screen.getByText('Two').closest('tr')!).queryByText('Disabled')).toBeNull();
    });

    it('a user without platform rights gets no actions column', async () => {
      session.user = user({ id: 'x', platform_role: 'user' });
      stubApi(() => ({ json: adminUsers() }));
      render(UsersPage);
      await screen.findByText('Two');
      expect(screen.queryByRole('button', { name: /^(Disable|Enable) / })).toBeNull();
    });
  });
});
