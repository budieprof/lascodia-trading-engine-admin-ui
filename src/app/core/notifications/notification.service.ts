import { Injectable, signal } from '@angular/core';

export type NotificationType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: number;
  type: NotificationType;
  message: string;
}

const AUTO_DISMISS_MS = 4000;

@Injectable({ providedIn: 'root' })
export class NotificationService {
  private nextId = 0;
  private readonly _toasts = signal<Toast[]>([]);

  readonly toasts = this._toasts.asReadonly();

  success(message: string): void {
    this.addToast('success', message);
  }

  error(message: string): void {
    this.addToast('error', message);
  }

  warning(message: string): void {
    this.addToast('warning', message);
  }

  info(message: string): void {
    this.addToast('info', message);
  }

  dismiss(id: number): void {
    this._toasts.update((toasts) => toasts.filter((t) => t.id !== id));
  }

  private addToast(type: NotificationType, message: string): void {
    const id = this.nextId++;
    const toast: Toast = { id, type, message };

    this._toasts.update((toasts) => [...toasts, toast]);

    setTimeout(() => this.dismiss(id), AUTO_DISMISS_MS);
  }
}
