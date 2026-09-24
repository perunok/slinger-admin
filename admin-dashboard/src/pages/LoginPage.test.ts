import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import LoginPage from './LoginPage.svelte';
import { session } from '../lib/state/session.svelte';
import { stubApi, user } from '../test/helpers';

describe('LoginPage', () => {
  it('validates before calling the API', async () => {
    const calls = stubApi(() => undefined);
    render(LoginPage);
    const ev = userEvent.setup();
    await ev.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter your email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    await ev.type(screen.getByLabelText('Email'), 'not-an-email');
    await ev.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
  });

  it('submits once even if activated repeatedly, and disables the button while busy', async () => {
    let logins = 0;
    stubApi((r) => {
      if (r.path === '/auth/browser/login') {
        logins++;
        return { json: { user: user(), csrf_token: 't' } };
      }
    }, 150);
    render(LoginPage);
    const ev = userEvent.setup();
    await ev.type(screen.getByLabelText('Email'), 'a@example.com');
    await ev.type(screen.getByLabelText('Password'), 'secret-password');
    const btn = screen.getByRole('button', { name: 'Sign in' });
    await ev.dblClick(btn);
    expect(btn).toBeDisabled();
    await waitFor(() => expect(session.status).toBe('authenticated'));
    expect(logins).toBe(1);
  });

  it('shows the server message on bad credentials and the session-expired notice', async () => {
    session.status = 'anonymous';
    session.notice = 'Your session has expired. Please sign in again.';
    stubApi(() => ({ status: 401, json: { error: { code: 'unauthenticated', message: 'Incorrect email or password.' } } }));
    render(LoginPage);
    expect(screen.getByText(/session has expired/i)).toBeInTheDocument();
    const ev = userEvent.setup();
    await ev.type(screen.getByLabelText('Email'), 'a@example.com');
    await ev.type(screen.getByLabelText('Password'), 'x');
    await ev.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Incorrect email or password.')).toBeInTheDocument();
    expect(session.status).toBe('anonymous');
  });
});
