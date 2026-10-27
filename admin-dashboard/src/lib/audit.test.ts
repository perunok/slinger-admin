import { describe, expect, it } from 'vitest';
import type { AuditLog } from './api/schemas';
import { actionLabel, actorLabel, detailLines, searchText, targetLabel } from './audit';

const entry = (o: Partial<AuditLog>): AuditLog => ({ id: 'a1', action: 'content.updated', created_at: '2026-10-27T10:00:00Z', ...o });

describe('audit entries', () => {
  it('labels content actions and keeps the dotted names readable', () => {
    expect(actionLabel('content.created')).toBe('Content created');
    expect(actionLabel('content.updated')).toBe('Content edited');
    expect(actionLabel('content.deleted')).toBe('Content deleted');
    expect(actionLabel('sync.push')).toBe('Synced from a device');
    expect(actionLabel('member.role_changed')).toBe('Member role changed');
  });

  it('names the actor by name and email', () => {
    expect(actorLabel(entry({ actor_name: 'Ada', actor_email: 'ada@x.test' }))).toBe('Ada (ada@x.test)');
    expect(actorLabel(entry({ actor_email: 'ada@x.test' }))).toBe('ada@x.test');
    expect(actorLabel(entry({}))).toBe('system');
  });

  it('shows what was edited, where and what changed', () => {
    const l = entry({
      resource_type: 'request', resource_id: 'r1',
      details: {
        name: 'List invoices', collection: 'Billing API', device: 'Laptop',
        changes: [{ field: 'url', from: 'https://a.test', to: 'https://b.test' }, { field: 'headers' }, { field: 'name', from: null, to: 'x' }],
      },
    });
    expect(targetLabel(l)).toBe('Request “List invoices” in Billing API');
    expect(detailLines(l)).toEqual(['url: https://a.test → https://b.test', 'headers changed', 'name: (empty) → x', 'from Laptop']);
    expect(searchText(l)).toContain('Billing API');
  });

  it('summarises a deletion with what went with it, and a sync push', () => {
    expect(detailLines(entry({ action: 'content.deleted', details: { name: 'Old', removed: { requests: 3, folders: 1, versions: 0 } } }))).toEqual([
      'with 3 requests, 1 folder',
    ]);
    expect(detailLines(entry({ action: 'sync.push', details: { accepted: 4, rejected: 1, accepted_by_type: { request: 4 } } }))).toEqual([
      '4 changes accepted, 1 rejected',
    ]);
    expect(detailLines(entry({ action: 'content.updated', details: { name: 'x' } }))).toEqual(['changed (details not recorded)']);
  });

  it('lists other details as readable pairs, skipping nested objects', () => {
    expect(detailLines(entry({ action: 'member.role_changed', details: { from_role: 'viewer', to_role: 'editor', meta: { a: 1 } } }))).toEqual([
      'From role: viewer',
      'To role: editor',
    ]);
  });
});
