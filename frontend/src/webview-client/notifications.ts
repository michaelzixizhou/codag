/**
 * Notification queue system with slide-up stacking.
 * Handles loading, progress, success, error, warning, and info notifications.
 */

export interface ProgressData {
    completed: number;
    total: number;
    filesAnalyzed?: number;
    elapsed?: number;
}

export interface NotificationOptions {
    type: 'loading' | 'progress' | 'success' | 'error' | 'warning' | 'info';
    message: string;
    subtext?: string;
    progress?: ProgressData;
    dismissMs?: number;
}

interface Notification {
    id: string;
    type: NotificationOptions['type'];
    message: string;
    subtext?: string;
    timestamp: number;
    dismissAt?: number;
    progress?: ProgressData;
    element?: HTMLElement;
}

// Auto-dismiss timings (ms)
const DISMISS_TIMINGS: Record<string, number> = {
    success: 2000,
    error: 5000,
    warning: 4000,
    info: 3000
};

class NotificationQueue {
    private items: Notification[] = [];
    private container: HTMLElement | null = null;
    private readonly MAX_VISIBLE = 4;
    private progressThrottleTimer: number | null = null;
    private pendingProgress: ProgressData | null = null;
    private readonly PROGRESS_THROTTLE_MS = 100;
    private idCounter = 0;

    /**
     * Initialize the notification queue with a container element.
     */
    init(containerId: string): void {
        this.container = document.getElementById(containerId);
        if (!this.container) {
            console.warn(`[Notifications] Container #${containerId} not found`);
        }
    }

    /**
     * Show a notification. Returns the notification ID.
     * Each call creates a new notification (true queue behavior).
     * Loading/progress notifications replace each other (only 1 active at a time).
     */
    show(opts: NotificationOptions): string {
        const id = `notif-${++this.idCounter}`;
        const now = Date.now();

        const dismissMs = opts.dismissMs ?? DISMISS_TIMINGS[opts.type];
        const notification: Notification = {
            id,
            type: opts.type,
            message: opts.message,
            subtext: opts.subtext,
            timestamp: now,
            dismissAt: dismissMs ? now + dismissMs : undefined,
            progress: opts.progress
        };

        // For loading/progress, replace existing instead of stacking
        if (opts.type === 'loading' || opts.type === 'progress') {
            const existingIdx = this.items.findIndex(n => n.type === 'loading' || n.type === 'progress');
            if (existingIdx >= 0) {
                const old = this.items[existingIdx];
                if (old.element) {
                    old.element.remove();
                }
                this.items.splice(existingIdx, 1);
            }
        }

        this.items.push(notification);
        this.enforceMaxVisible();
        this.render(notification);
        this.scheduleAutoDismiss(notification);

        return id;
    }

    /**
     * Update loading notification text in-place (no flicker).
     */
    updateLoadingText(message: string, subtext?: string): void {
        const existing = this.items.find(n => n.type === 'loading');
        if (existing) {
            existing.message = message;
            existing.subtext = subtext;
            this.updateElement(existing);
        }
    }

    /**
     * Update progress notification with new data.
     * Uses throttling with pending state to ensure final update is never lost.
     */
    updateProgress(data: ProgressData): void {
        // Always store latest data
        this.pendingProgress = data;

        // If throttled, the pending data will be applied when timer fires
        if (this.progressThrottleTimer !== null) {
            return;
        }

        // Apply immediately
        this.applyProgressUpdate();

        // Set throttle timer
        this.progressThrottleTimer = window.setTimeout(() => {
            this.progressThrottleTimer = null;
            // Apply any pending update that came in during throttle
            if (this.pendingProgress) {
                this.applyProgressUpdate();
            }
        }, this.PROGRESS_THROTTLE_MS);
    }

    private applyProgressUpdate(): void {
        const data = this.pendingProgress;
        if (!data) return;

        this.pendingProgress = null;

        const existing = this.items.find(n => n.type === 'progress' || n.type === 'loading');

        if (existing) {
            existing.type = 'progress';
            existing.progress = data;
            existing.message = `Analyzing... ${data.completed}/${data.total} batches`;

            // Build subtext
            const parts: string[] = [];
            if (data.filesAnalyzed) {
                parts.push(`${data.filesAnalyzed} files`);
            }
            if (data.elapsed) {
                parts.push(`${(data.elapsed / 1000).toFixed(1)}s`);
            }
            existing.subtext = parts.join(' · ');

            this.updateElement(existing);
        } else {
            this.show({
                type: 'progress',
                message: `Analyzing... ${data.completed}/${data.total} batches`,
                progress: data
            });
        }
    }

    /**
     * Dismiss a notification by ID.
     */
    dismiss(id: string): void {
        const idx = this.items.findIndex(n => n.id === id);
        if (idx === -1) return;

        const notification = this.items[idx];
        if (notification.element) {
            notification.element.classList.remove('visible');
            notification.element.classList.add('exiting');

            // Capture index before timeout to avoid stale reference
            setTimeout(() => {
                notification.element?.remove();
                // Verify notification is still at expected position before splicing
                const currentIdx = this.items.indexOf(notification);
                if (currentIdx !== -1) {
                    this.items.splice(currentIdx, 1);
                }
                this.updateStackClasses();
            }, 200);
        } else {
            this.items.splice(idx, 1);
        }
    }

    /**
     * Dismiss all notifications of a given type.
     */
    dismissType(type: NotificationOptions['type']): void {
        // Clear pending progress to prevent race condition where throttle timer
        // fires after dismiss and recreates the notification
        if (type === 'progress' || type === 'loading') {
            this.pendingProgress = null;
            if (this.progressThrottleTimer !== null) {
                clearTimeout(this.progressThrottleTimer);
                this.progressThrottleTimer = null;
            }
        }

        const toRemove = this.items.filter(n => n.type === type);
        toRemove.forEach(n => this.dismiss(n.id));
    }

    /**
     * Clear all notifications.
     */
    clear(): void {
        this.items.forEach(n => {
            if (n.element) {
                n.element.remove();
            }
        });
        this.items = [];
    }

    private enforceMaxVisible(): void {
        while (this.items.length > this.MAX_VISIBLE) {
            const oldest = this.items.shift();
            if (oldest?.element) {
                oldest.element.classList.add('exiting');
                setTimeout(() => oldest.element?.remove(), 200);
            }
        }
    }

    private render(notification: Notification): void {
        if (!this.container) return;

        const el = document.createElement('div');
        el.className = 'notification-item';
        if (notification.progress) {
            el.classList.add('has-progress');
        }
        el.dataset.id = notification.id;
        el.dataset.type = notification.type;

        // Accessibility attributes
        el.setAttribute('role', 'alert');
        el.setAttribute('aria-live', notification.type === 'error' ? 'assertive' : 'polite');

        el.innerHTML = this.buildContent(notification);
        notification.element = el;

        // Add close button click handler
        const closeBtn = el.querySelector('.notification-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.dismiss(notification.id);
            });
        }

        this.container.appendChild(el);

        // Trigger reflow then add visible class for animation
        el.offsetHeight;
        requestAnimationFrame(() => {
            el.classList.add('visible');
            this.updateStackClasses();
        });
    }

    private buildContent(n: Notification): string {
        const icon = this.getIcon(n.type);
        const progressBar = n.progress ? this.buildProgressBar(n.progress) : '';
        const subtext = n.subtext ? `<div class="notification-subtext">${n.subtext}</div>` : '';

        return `
            <div class="notification-content">
                <div class="notification-icon">${icon}</div>
                <div class="notification-body">
                    <div class="notification-message">${n.message}</div>
                    ${subtext}
                    ${progressBar}
                </div>
                <button class="notification-close" aria-label="Dismiss">×</button>
            </div>
        `;
    }

    private buildProgressBar(progress: ProgressData): string {
        const percent = progress.total > 0
            ? Math.round((progress.completed / progress.total) * 100)
            : 0;
        return `
            <div class="notification-progress">
                <div class="notification-progress-bar" style="width: ${percent}%"></div>
            </div>
        `;
    }

    private getIcon(type: NotificationOptions['type']): string {
        switch (type) {
            case 'loading':
            case 'progress':
                return '<svg class="spinner-pill" viewBox="0 0 24 24" width="14" height="14"><rect x="8" y="2" width="8" height="20" rx="4" ry="4" fill="currentColor"/></svg>';
            case 'success':
                return '<span class="icon-success">✓</span>';
            case 'error':
                return '<span class="icon-error">✕</span>';
            case 'warning':
                return '<span class="icon-warning">⚠</span>';
            case 'info':
                return '<span class="icon-info">ℹ</span>';
        }
    }

    private updateElement(notification: Notification): void {
        if (!notification.element) return;
        notification.element.classList.toggle('has-progress', !!notification.progress);
        notification.element.innerHTML = this.buildContent(notification);
        // Re-attach close handler after innerHTML replacement
        const newCloseBtn = notification.element.querySelector('.notification-close');
        if (newCloseBtn) {
            newCloseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.dismiss(notification.id);
            });
        }
    }

    private updateStackClasses(): void {
        const visible = this.items.filter(n => n.element?.classList.contains('visible'));
        // Newest is last in array, should be focused (on top visually)
        visible.forEach((n, i) => {
            if (!n.element) return;
            const isNewest = i === visible.length - 1;
            n.element.classList.toggle('focused', isNewest);
            n.element.classList.toggle('stacked', !isNewest);
        });
    }

    private scheduleAutoDismiss(notification: Notification): void {
        if (!notification.dismissAt) return;

        const delay = notification.dismissAt - Date.now();
        if (delay <= 0) {
            this.dismiss(notification.id);
            return;
        }

        setTimeout(() => {
            this.dismiss(notification.id);
        }, delay);
    }
}

// Export singleton instance
export const notifications = new NotificationQueue();
