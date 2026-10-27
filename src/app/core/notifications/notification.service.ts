import { Injectable, signal } from '@angular/core';

export type NotificationType = 'success' | 'error' | 'warning' | 'info';

/** An optional in-app link on a toast (e.g. "Open signal 123"); `route` is a router path. */
export interface ToastLink {
  label: string;
  route: string;
}

export interface Toast {
  id: number;
  type: NotificationType;
  message: string;
  link?: ToastLink;
}

const AUTO_DISMISS_MS = 4000;
/** A toast with a link stays longer, so the link can be reached. */
const LINK_DISMISS_MS = 10000;

@Injectable({ providedIn: 'root' })
export class NotificationService {
  private nextId = 0;
  private readonly _toasts = signal<Toast[]>([]);

  readonly toasts = this._toasts.asReadonly();

  success(message: string, link?: ToastLink): void {
    this.addToast('success', message, link);
  }

  error(message: string, link?: ToastLink): void {
    this.addToast('error', message, link);
  }

  warning(message: string, link?: ToastLink): void {
    this.addToast('warning', message, link);
  }

  info(message: string, link?: ToastLink): void {
    this.addToast('info', message, link);
  }

  dismiss(id: number): void {
    this._toasts.update((toasts) => toasts.filter((t) => t.id !== id));
  }

  private addToast(type: NotificationType, message: string, link?: ToastLink): void {
    // One live toast per distinct message. A burst of identical failures
    // (every tile on a page hitting the same refused endpoint) used to
    // stack a red column over the header; the repeat carries no new
    // information, so the existing toast simply stays up.
    if (this._toasts().some((t) => t.type === type && t.message === message)) return;

    const id = this.nextId++;
    const toast: Toast = link ? { id, type, message, link } : { id, type, message };

    this._toasts.update((toasts) => [...toasts, toast]);

    setTimeout(() => this.dismiss(id), link ? LINK_DISMISS_MS : AUTO_DISMISS_MS);
  }
}
