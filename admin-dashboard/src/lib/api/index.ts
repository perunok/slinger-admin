import { HttpClient } from './client';
import { createApi } from './endpoints';

/** Shared singleton. `main.ts` configures baseUrl (and the mock fetch in dev) before mounting. */
export const client = new HttpClient({ baseUrl: '' });
export const api = createApi(client);

export { ApiError, errorMessage } from './errors';
export { loadApiConfig, resolveApiConfig } from './config';
export { DEFAULT_PAGE_SIZE } from './endpoints';
export type * from './schemas';
