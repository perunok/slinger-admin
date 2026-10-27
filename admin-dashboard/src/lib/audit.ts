import type { AuditLog } from './api/schemas';
import { humanize } from './format';

/**
 * Readable audit entries. Content changes (`content.created|updated|deleted`, server `services/contentAudit.ts`) carry the
 * item's name, its collection or environment, the device a sync push came from and, for an update, what changed.
 */

const CONTENT_ACTIONS: Record<string, string> = {
  'content.created': 'Content created',
  'content.updated': 'Content edited',
  'content.deleted': 'Content deleted',
  'sync.push': 'Synced from a device',
};

/** `member.role_changed` -> "Member role changed"; `content.updated` -> "Content edited". */
export function actionLabel(action: string): string {
  return CONTENT_ACTIONS[action] ?? humanize(action.replace('.', ' '));
}

const TYPE_LABELS: Record<string, string> = {
  collection: 'Collection',
  folder: 'Folder',
  request: 'Request',
  environment: 'Environment',
  environment_variable: 'Environment variable',
  collection_variable: 'Collection variable',
  global_variable: 'Global variable',
  collection_version: 'Collection version',
};

export const typeLabel = (type: string | null | undefined) => (type ? (TYPE_LABELS[type] ?? humanize(type)) : '');

const text = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** "Ada Lovelace (ada@example.com)", or what is known of the actor. */
export function actorLabel(l: Pick<AuditLog, 'actor_name' | 'actor_email' | 'actor_user_id'>): string {
  if (l.actor_name && l.actor_email) return `${l.actor_name} (${l.actor_email})`;
  return l.actor_name ?? l.actor_email ?? l.actor_user_id ?? 'system';
}

/** `Request "List invoices" in Billing API`; for other entries the type and, when known, a name. */
export function targetLabel(l: Pick<AuditLog, 'resource_type' | 'details'>): string {
  const d = l.details ?? {};
  const name = text(d.name);
  const parts = [typeLabel(l.resource_type)];
  if (name) parts.push(`“${name}”`);
  const where = text(d.collection) ?? text(d.environment);
  if (where) parts.push(`in ${where}`);
  return parts.filter(Boolean).join(' ');
}

const shown = (v: unknown) => (v === null || v === undefined || v === '' ? '(empty)' : typeof v === 'string' ? v : JSON.stringify(v));

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The readable lines under an entry: what changed, what went with a deletion, where a sync came from. */
export function detailLines(l: Pick<AuditLog, 'action' | 'details'>): string[] {
  const d = l.details ?? {};
  const lines: string[] = [];
  if (l.action.startsWith('content.')) {
    if (Array.isArray(d.changes)) {
      for (const c of d.changes as Array<{ field?: unknown; from?: unknown; to?: unknown }>) {
        const field = text(c.field) ?? 'something';
        lines.push('from' in c || 'to' in c ? `${field}: ${shown(c.from)} → ${shown(c.to)}` : `${field} changed`);
      }
    } else if (l.action === 'content.updated') {
      lines.push('changed (details not recorded)');
    }
    if (d.removed && typeof d.removed === 'object') {
      const removed = Object.entries(d.removed as Record<string, number>)
        .filter(([, n]) => typeof n === 'number' && n > 0)
        .map(([k, n]) => plural(n, k.replace(/s$/, '')));
      if (removed.length) lines.push(`with ${removed.join(', ')}`);
    }
    if (text(d.device)) lines.push(`from ${d.device}`);
    return lines;
  }
  if (l.action === 'sync.push') {
    const accepted = typeof d.accepted === 'number' ? d.accepted : 0;
    const rejected = typeof d.rejected === 'number' ? d.rejected : 0;
    lines.push(`${plural(accepted, 'change')} accepted${rejected ? `, ${rejected} rejected` : ''}`);
    return lines;
  }
  for (const [k, v] of Object.entries(d)) {
    if (v === null || v === undefined || (typeof v === 'object' && !Array.isArray(v))) continue;
    lines.push(`${humanize(k)}: ${shown(v)}`);
  }
  return lines;
}

/** Text the "Find" box searches in. */
export function searchText(l: AuditLog): string {
  return [actorLabel(l), actionLabel(l.action), targetLabel(l), l.resource_id ?? '', ...detailLines(l)].join(' ');
}
