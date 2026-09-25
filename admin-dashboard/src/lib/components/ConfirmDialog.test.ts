import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import ConfirmDialog from './ConfirmDialog.svelte';

const children = createRawSnippet(() => ({ render: () => '<p>Are you sure?</p>' }));

describe('ConfirmDialog typed confirmation', () => {
  it('keeps the confirm button disabled until the exact name is typed', async () => {
    const onconfirm = vi.fn();
    render(ConfirmDialog, { props: { title: 'Delete', confirmLabel: 'Delete it', typedConfirmation: 'acme', onconfirm, oncancel: vi.fn(), children } });
    const ev = userEvent.setup();
    const btn = screen.getByRole('button', { name: 'Delete it', hidden: true });
    expect(btn).toBeDisabled();
    await ev.type(screen.getByLabelText(/type/i, { selector: 'input' }), 'acm');
    expect(btn).toBeDisabled();
    await ev.type(screen.getByLabelText(/type/i, { selector: 'input' }), 'e');
    expect(btn).toBeEnabled();
    await ev.click(btn);
    expect(onconfirm).toHaveBeenCalledTimes(1);
  });

  it('blocks confirm while busy', () => {
    render(ConfirmDialog, { props: { title: 'Remove', confirmLabel: 'Remove', busy: true, onconfirm: vi.fn(), oncancel: vi.fn(), children } });
    expect(screen.getByRole('button', { name: /remove/i, hidden: true })).toBeDisabled();
  });
});
