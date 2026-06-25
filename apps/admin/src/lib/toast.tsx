import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { cn } from './utils.js';

type ToastKind = 'success' | 'error';

interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly message: string;
}

export interface ToastApi {
  success(message: string): void;
  error(message: string): void;
}

const ToastCtx = createContext<ToastApi | null>(null);

/** Transient notifications. Errors stay longer than successes; both auto-dismiss. */
export function useToast(): ToastApi {
  const api = useContext(ToastCtx);
  if (!api) throw new Error('useToast must be used within <ToastProvider>');
  return api;
}

export function ToastProvider(props: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      seq.current += 1;
      const id = seq.current;
      setToasts((prev) => [...prev, { id, kind, message }]);
      setTimeout(() => dismiss(id), kind === 'error' ? 6000 : 3500);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push('success', m),
      error: (m) => push('error', m),
    }),
    [push],
  );

  return (
    <ToastCtx.Provider value={api}>
      {props.children}
      <div
        className="fixed bottom-4 right-4 z-50 flex flex-col gap-2"
        aria-live="polite"
        aria-atomic="false"
      >
        {toasts.map((t) => (
          <output
            key={t.id}
            className={cn(
              'flex min-w-60 max-w-md items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-sm text-card-foreground shadow-lg',
              t.kind === 'success' ? 'border-success/50' : 'border-destructive/50',
            )}
          >
            <span className="flex-1">{t.message}</span>
            <button
              type="button"
              className="text-lg leading-none text-muted-foreground hover:text-foreground"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
            >
              ×
            </button>
          </output>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
