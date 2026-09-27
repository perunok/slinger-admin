import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import App from './App.svelte';
import { session } from './lib/state/session.svelte';
import { stubApi, user } from './test/helpers';

const emptyPage = { items: [], page: { next_cursor: null, has_more: false } };

describe('App: must_change_password', () => {
  beforeEach(() => {
    window.location.hash = '#/workspaces';
    session.status = 'booting';
    session.user = null;
  });

  it('routes a flagged account straight to "Choose a new password" and into the dashboard after the change', async () => {
    let flagged = true;
    const calls = stubApi((r) => {
      if (r.path === '/auth/browser/session') return { json: { user: user({ must_change_password: flagged }), csrf_token: 'c1' } };
      if (r.path === '/me/password') {
        flagged = false;
        return { json: { ok: true } };
      }
      if (r.path === '/workspaces') return flagged ? { status: 403, json: { error: { code: 'password_change_required', message: 'x' } } } : { json: emptyPage };
    });
    render(App, { props: { config: { ok: true, baseUrl: '/api' } } });
    expect(await screen.findByRole('heading', { name: 'Choose a new password' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(calls.some((c) => c.path === '/workspaces')).toBe(false); // nothing else is loaded meanwhile

    const ev = userEvent.setup();
    await ev.type(screen.getByLabelText('Temporary password'), 'temporary-pass-1');
    await ev.type(screen.getByLabelText('New password'), 'My-own-new-password-1');
    await ev.type(screen.getByLabelText('Confirm new password'), 'My-own-new-password-1');
    await ev.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/me/password')!.headers.get('X-CSRF-Token')).toBe('c1');
  });

  it('a 403 password_change_required while signed in switches to the forced screen', async () => {
    stubApi((r) => {
      if (r.path === '/auth/browser/session') return { json: { user: user(), csrf_token: 'c1' } };
      if (r.path === '/workspaces') return { status: 403, json: { error: { code: 'password_change_required', message: 'x' } } };
    });
    render(App, { props: { config: { ok: true, baseUrl: '/api' } } });
    expect(await screen.findByRole('heading', { name: 'Choose a new password' })).toBeInTheDocument();
    await waitFor(() => expect(session.user?.must_change_password).toBe(true));
  });

  it('the user menu links to the account page with the change-password form', async () => {
    stubApi((r) => {
      if (r.path === '/auth/browser/session') return { json: { user: user({ display_name: 'Ann' }), csrf_token: 'c1' } };
      return { json: emptyPage };
    });
    render(App, { props: { config: { ok: true, baseUrl: '/api' } } });
    const link = await screen.findByRole('link', { name: /Ann/ });
    expect(link).toHaveAttribute('href', '#/account');
    await userEvent.setup().click(link);
    expect(await screen.findByRole('heading', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Change password' })).toBeInTheDocument();
    expect(screen.getByLabelText('Current password')).toBeInTheDocument();
  });
});
