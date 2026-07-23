import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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

const durationOf = (kind: ToastKind) => (kind === 'error' ? 6000 : 3500);

/** Transient notifications. Errors stay longer than successes; both auto-dismiss. */
export function useToast(): ToastApi {
  const api = useContext(ToastCtx);
  if (!api) throw new Error('useToast must be used within <ToastProvider>');
  return api;
}

export function ToastProvider(props: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  // Per-toast dismiss timers, so hovering (or focusing the dismiss button)
  // pauses auto-dismiss and a missed error can actually be read.
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, []);

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pause = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const resume = useCallback(
    (id: number, kind: ToastKind) => {
      if (timers.current.has(id)) return;
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), durationOf(kind)),
      );
    },
    [dismiss],
  );

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      seq.current += 1;
      const id = seq.current;
      setToasts((prev) => [...prev, { id, kind, message }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), durationOf(kind)),
      );
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
            onMouseEnter={() => pause(t.id)}
            onMouseLeave={() => resume(t.id, t.kind)}
            onFocus={() => pause(t.id)}
            onBlur={() => resume(t.id, t.kind)}
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
