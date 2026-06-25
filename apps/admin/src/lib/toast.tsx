import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

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
      <div className="toaster" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <output key={t.id} className={`toast ${t.kind}`}>
            <span>{t.message}</span>
            <button
              type="button"
              className="toast-x"
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
