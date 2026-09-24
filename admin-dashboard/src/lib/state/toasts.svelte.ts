export type ToastKind = 'success' | 'error' | 'info';
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

class Toasts {
  items = $state<Toast[]>([]);
  private nextId = 1;
  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  push(kind: ToastKind, message: string, ttl = kind === 'error' ? 8000 : 4500) {
    const id = this.nextId++;
    this.items = [...this.items, { id, kind, message }].slice(-5);
    this.timers.set(id, setTimeout(() => this.dismiss(id), ttl));
    return id;
  }
  success = (m: string) => this.push('success', m);
  error = (m: string) => this.push('error', m);
  info = (m: string) => this.push('info', m);

  dismiss(id: number) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.items = this.items.filter((t) => t.id !== id);
  }
}

export const toasts = new Toasts();
