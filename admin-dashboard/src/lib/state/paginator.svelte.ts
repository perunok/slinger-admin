import type { Page } from '../api/schemas';
import { errorMessage } from '../api/errors';

export type PaginatorStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Cursor pagination state for one list. `load()` (re)starts from the first page;
 * `loadMore()` appends the next one. Responses from superseded loads are ignored,
 * so rapid filter/search changes cannot show stale data.
 */
export class Paginator<T> {
  items = $state<T[]>([]);
  status = $state<PaginatorStatus>('idle');
  error = $state<string | null>(null);
  loadingMore = $state(false);
  loadMoreError = $state<string | null>(null);
  hasMore = $state(false);

  private cursor: string | null = null;
  private generation = 0;

  constructor(private readonly fetchPage: (cursor: string | null) => Promise<Page<T>>) {}

  async load(): Promise<void> {
    const gen = ++this.generation;
    this.status = 'loading';
    this.error = null;
    this.loadMoreError = null;
    this.loadingMore = false;
    try {
      const page = await this.fetchPage(null);
      if (gen !== this.generation) return;
      this.items = page.items;
      this.cursor = page.page.next_cursor;
      this.hasMore = page.page.has_more && page.page.next_cursor !== null;
      this.status = 'ready';
    } catch (e) {
      if (gen !== this.generation) return;
      this.error = errorMessage(e);
      this.status = 'error';
    }
  }

  async loadMore(): Promise<void> {
    if (this.loadingMore || !this.hasMore || this.status !== 'ready') return;
    const gen = this.generation;
    this.loadingMore = true;
    this.loadMoreError = null;
    try {
      const page = await this.fetchPage(this.cursor);
      if (gen !== this.generation) return;
      this.items = [...this.items, ...page.items];
      this.cursor = page.page.next_cursor;
      this.hasMore = page.page.has_more && page.page.next_cursor !== null;
    } catch (e) {
      if (gen !== this.generation) return;
      this.loadMoreError = errorMessage(e);
    } finally {
      if (gen === this.generation) this.loadingMore = false;
    }
  }

  /** Local edits after a successful mutation. */
  patch(match: (item: T) => boolean, update: (item: T) => T) {
    this.items = this.items.map((i) => (match(i) ? update(i) : i));
  }
  remove(match: (item: T) => boolean) {
    this.items = this.items.filter((i) => !match(i));
  }
  prepend(item: T) {
    this.items = [item, ...this.items];
  }
}
