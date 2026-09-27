import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import ChangePasswordForm from './ChangePasswordForm.svelte';
import { session } from '../state/session.svelte';
import { toasts } from '../state/toasts.svelte';
import { stubApi, user } from '../../test/helpers';

const NEW = 'A-brand-new-passphrase';

async function fill(current: string, next: string, confirm = next) {
  const ev = userEvent.setup();
  if (current) await ev.type(screen.getByLabelText(/^(Current|Temporary) password$/), current);
  if (next) await ev.type(screen.getByLabelText('New password'), next);
  if (confirm) await ev.type(screen.getByLabelText('Confirm new password'), confirm);
  await ev.click(screen.getByRole('button', { name: /change password|set new password/i }));
}

describe('ChangePasswordForm', () => {
  beforeEach(() => {
    toasts.items = [];
    session.status = 'authenticated';
    session.user = user({ must_change_password: false });
  });

  it('shows the password rules and validates locally before calling the API', async () => {
    const calls = stubApi(() => undefined);
    render(ChangePasswordForm);
    expect(screen.getByText(/at least 12 characters/i)).toBeInTheDocument();
    expect(screen.getByText(/different from your current password/i)).toBeInTheDocument();
    await fill('old-password-123', 'short');
    expect(await screen.findByText('The new password must be at least 12 characters.')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('checks confirmation and "must differ"', async () => {
    const calls = stubApi(() => undefined);
    render(ChangePasswordForm);
    await fill('same-password-123', 'same-password-123');
    expect(await screen.findByText('The new password must differ from the current one.')).toBeInTheDocument();
    const ev = userEvent.setup();
    await ev.clear(screen.getByLabelText('New password'));
    await ev.type(screen.getByLabelText('New password'), NEW);
    await ev.clear(screen.getByLabelText('Confirm new password'));
    await ev.type(screen.getByLabelText('Confirm new password'), `${NEW}x`);
    await ev.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('The passwords do not match.')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('sends the change once, clears the fields and the must-change flag', async () => {
    session.user = user({ must_change_password: true });
    let n = 0;
    const calls = stubApi((r) => {
      if (r.path === '/me/password') {
        n++;
        return { json: { ok: true } };
      }
    }, 50);
    render(ChangePasswordForm, { props: { forced: true } });
    await fill('temp-password-xyz', NEW);
    await waitFor(() => expect(session.user?.must_change_password).toBe(false));
    expect(n).toBe(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ current_password: 'temp-password-xyz', new_password: NEW });
    expect(screen.getByLabelText('New password')).toHaveValue('');
    expect(toasts.items.at(-1)?.message).toMatch(/other session/i);
  });

  it('maps a wrong current password to the field', async () => {
    stubApi(() => ({ status: 403, json: { error: { code: 'forbidden', message: 'current password is incorrect', details: { reason: 'invalid_current_password' } } } }));
    render(ChangePasswordForm);
    await fill('wrong-password-1', NEW);
    expect(await screen.findByText('The current password is incorrect.')).toBeInTheDocument();
    expect(screen.getByLabelText('Current password')).toHaveValue('');
    expect(session.status).toBe('authenticated');
  });

  it('shows server-side policy errors on the new password field', async () => {
    stubApi(() => ({ status: 400, json: { error: { code: 'invalid_request', message: 'request validation failed', details: { issues: [{ path: 'new_password', message: 'the new password must differ from the current one' }] } } } }));
    render(ChangePasswordForm);
    await fill('old-password-123', NEW);
    expect(await screen.findByText('the new password must differ from the current one')).toBeInTheDocument();
  });

  it('explains rate limiting with the retry delay', async () => {
    stubApi(() => ({ status: 429, json: { error: { code: 'rate_limited', message: 'too many attempts, slow down', details: { retry_after_seconds: 42 } } } }));
    render(ChangePasswordForm);
    await fill('old-password-123', NEW);
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Try again in 42 seconds.');
  });
});
