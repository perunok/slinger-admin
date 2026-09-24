import { describe, expect, it } from 'vitest';
import { Paginator } from './paginator.svelte';
import type { Page } from '../api/schemas';
import { ApiError } from '../api/errors';

const page = (items: number[], next: string | null): Page<number> => ({ items, page: { next_cursor: next, has_more: next !== null } });
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe('Paginator', () => {
  it('loads the first page, then appends using the returned cursor', async () => {
    const cursors: (string | null)[] = [];
    const p = new Paginator<number>(async (c) => {
      cursors.push(c);
      return c === null ? page([1, 2], 'c2') : c === 'c2' ? page([3, 4], 'c3') : page([5], null);
    });
    await p.load();
    expect(p.items).toEqual([1, 2]);
    expect(p.hasMore).toBe(true);
    await p.loadMore();
    await p.loadMore();
    expect(p.items).toEqual([1, 2, 3, 4, 5]);
    expect(p.hasMore).toBe(false);
    expect(cursors).toEqual([null, 'c2', 'c3']);
    await p.loadMore(); // no-op when exhausted
    expect(cursors).toHaveLength(3);
  });

  it('does not issue overlapping loadMore calls', async () => {
    const d = deferred<Page<number>>();
    let calls = 0;
    const p = new Paginator<number>(async (c) => {
      calls++;
      return c === null ? page([1], 'n') : d.promise;
    });
    await p.load();
    const a = p.loadMore();
    const b = p.loadMore();
    d.resolve(page([2], null));
    await Promise.all([a, b]);
    expect(calls).toBe(2);
    expect(p.items).toEqual([1, 2]);
  });

  it('ignores responses from a superseded load (fast search typing)', async () => {
    const slow = deferred<Page<number>>();
    let n = 0;
    const p = new Paginator<number>(() => (n++ === 0 ? slow.promise : Promise.resolve(page([99], null))));
    const first = p.load();
    await p.load();
    slow.resolve(page([1], null));
    await first;
    expect(p.items).toEqual([99]);
  });

  it('exposes load errors, keeps items on loadMore errors, and can retry', async () => {
    let fail = true;
    const p = new Paginator<number>(async (c) => {
      if (c === 'n' && fail) throw new ApiError({ kind: 'network', code: 'network_error', message: 'offline' });
      return c === null ? page([1], 'n') : page([2], null);
    });
    await p.load();
    await p.loadMore();
    expect(p.loadMoreError).toBe('offline');
    expect(p.items).toEqual([1]);
    fail = false;
    await p.loadMore();
    expect(p.items).toEqual([1, 2]);
    expect(p.loadMoreError).toBeNull();

    const bad = new Paginator<number>(async () => {
      throw new ApiError({ kind: 'http', status: 500, code: 'x', message: 'server down' });
    });
    await bad.load();
    expect(bad.status).toBe('error');
    expect(bad.error).toBe('server down');
  });

  it('patch/remove/prepend edit locally', async () => {
    const p = new Paginator<{ id: number; v: string }>(async () => ({ items: [{ id: 1, v: 'a' }, { id: 2, v: 'b' }], page: { next_cursor: null, has_more: false } }));
    await p.load();
    p.patch((x) => x.id === 1, (x) => ({ ...x, v: 'z' }));
    p.remove((x) => x.id === 2);
    p.prepend({ id: 0, v: 'n' });
    expect(p.items.map((x) => x.v)).toEqual(['n', 'z']);
  });
});
