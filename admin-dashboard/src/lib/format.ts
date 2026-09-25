export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export const humanize = (s: string) => s.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function statusTone(status: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  switch (status) {
    case 'active':
    case 'ok':
    case 'ready':
    case 'approved':
    case 'accepted':
      return 'success';
    case 'pending':
    case 'pending_verification':
    case 'degraded':
      return 'warning';
    case 'revoked':
    case 'rejected':
    case 'expired':
    case 'failed':
    case 'down':
    case 'error':
      return 'danger';
    default:
      return 'neutral';
  }
}
