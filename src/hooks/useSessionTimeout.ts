import { useEffect, useRef, useCallback, useState } from "react";

const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const WARNING_MS = 25 * 60 * 1000; // warning at 25 minutes

export function useSessionTimeout(onTimeout: () => void) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTimeoutRef = useRef(onTimeout);
  const lastActivityRef = useRef(Date.now());
  const expiredRef = useRef(false);
  const [showWarning, setShowWarning] = useState(false);

  onTimeoutRef.current = onTimeout;

  const clearTimers = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
    timerRef.current = null;
    warningTimerRef.current = null;
  }, []);

  /**
   * Schedules against the absolute last-activity timestamp rather than "now".
   *
   * The previous implementation cleared both timers when the tab was hidden and
   * called reset() when it came back, so a shop terminal left on a background
   * tab never timed out at all — the 30 minutes restarted on every return. Here
   * the deadline is wall-clock based: timers keep running while hidden, and the
   * elapsed time is re-checked on return in case the browser throttled them.
   */
  const schedule = useCallback(() => {
    clearTimers();
    if (expiredRef.current) return;

    const elapsed = Date.now() - lastActivityRef.current;

    if (elapsed >= TIMEOUT_MS) {
      expiredRef.current = true;
      setShowWarning(false);
      onTimeoutRef.current();
      return;
    }

    if (elapsed >= WARNING_MS) {
      setShowWarning(true);
    } else {
      setShowWarning(false);
      warningTimerRef.current = setTimeout(() => setShowWarning(true), WARNING_MS - elapsed);
    }

    timerRef.current = setTimeout(() => {
      expiredRef.current = true;
      setShowWarning(false);
      onTimeoutRef.current();
    }, TIMEOUT_MS - elapsed);
  }, [clearTimers]);

  const resetTimer = useCallback(() => {
    lastActivityRef.current = Date.now();
    expiredRef.current = false;
    schedule();
  }, [schedule]);

  useEffect(() => {
    const events = ["mousedown", "keydown", "touchstart"] as const;
    const handler = () => resetTimer();
    events.forEach((e) => document.addEventListener(e, handler, { passive: true }));

    const onVisibilityChange = () => {
      if (!document.hidden) schedule();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    resetTimer();

    return () => {
      events.forEach((e) => document.removeEventListener(e, handler));
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearTimers();
    };
  }, [resetTimer, schedule, clearTimers]);

  return { showWarning, extendSession: resetTimer };
}
