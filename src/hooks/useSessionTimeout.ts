import { useEffect, useRef, useCallback, useState } from "react";

const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const WARNING_MS = 25 * 60 * 1000; // warning at 25 minutes

export function useSessionTimeout(onTimeout: () => void) {
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const warningTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const onTimeoutRef = useRef(onTimeout);
  const [showWarning, setShowWarning] = useState(false);

  onTimeoutRef.current = onTimeout;

  const resetTimer = useCallback(() => {
    setShowWarning(false);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (warningTimerRef.current) clearTimeout(warningTimerRef.current);

    warningTimerRef.current = setTimeout(() => {
      setShowWarning(true);
    }, WARNING_MS);

    timerRef.current = setTimeout(() => {
      onTimeoutRef.current();
    }, TIMEOUT_MS);
  }, []);

  useEffect(() => {
    const events = ["mousedown", "keydown", "touchstart"] as const;
    const handler = () => resetTimer();

    events.forEach((e) => document.addEventListener(e, handler, { passive: true }));
    resetTimer();

    // Pause timer when tab is hidden, resume when visible
    const onVisibilityChange = () => {
      if (document.hidden) {
        if (timerRef.current) clearTimeout(timerRef.current);
        if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
      } else {
        resetTimer();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      events.forEach((e) => document.removeEventListener(e, handler));
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timerRef.current) clearTimeout(timerRef.current);
      if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
    };
  }, [resetTimer]);

  const extendSession = useCallback(() => {
    resetTimer();
  }, [resetTimer]);

  return { showWarning, extendSession };
}
