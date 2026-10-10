import { useEffect, useRef, useState } from 'react';
import { refreshSession } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button } from './ui';

/** Read by the sign-in page, to say why the person is looking at it. */
export const IDLE_NOTE = 'fb.signed-out-idle';
const WARN_SECONDS = 60;
/** While someone is working, the server is told so about this often (it ends sessions that go quiet). */
const KEEP_ALIVE_MS = 5 * 60_000;

/**
 * Signs the person out after the time their organisation allows away from the keyboard, with a minute's
 * warning. "Away" is no key, click, touch or scroll in this window. The server enforces the same time, so a
 * closed laptop or a browser left open overnight is signed out too.
 */
export function IdleSignOut({ tickMs = 5000 }: { tickMs?: number }) {
  const { me, signOut } = useAuth();
  const minutes = me?.org.idleMinutes ?? 0;
  const lastActive = useRef(Date.now());
  const lastKeepAlive = useRef(Date.now());
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  useEffect(() => {
    if (!minutes) return;
    const limit = minutes * 60_000;
    lastActive.current = Date.now();
    const seen = () => {
      lastActive.current = Date.now();
    };
    const events = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, seen, { passive: true, capture: true });
    const timer = window.setInterval(() => {
      const away = Date.now() - lastActive.current;
      if (away >= limit) {
        window.clearInterval(timer);
        try {
          window.sessionStorage.setItem(IDLE_NOTE, String(minutes));
        } catch {
          /* private browsing: the note is a nicety */
        }
        void signOut();
        return;
      }
      setSecondsLeft(limit - away <= WARN_SECONDS * 1000 ? Math.max(1, Math.ceil((limit - away) / 1000)) : null);
      // Still at work: say so, so the server does not end the session under them.
      if (away < tickMs * 2 && Date.now() - lastKeepAlive.current > KEEP_ALIVE_MS) {
        lastKeepAlive.current = Date.now();
        void refreshSession();
      }
    }, tickMs);
    return () => {
      window.clearInterval(timer);
      for (const e of events) window.removeEventListener(e, seen, { capture: true });
    };
  }, [minutes, signOut, tickMs]);

  if (secondsLeft === null) return null;
  return (
    <div className="st-idle" role="alertdialog" aria-label="Are you still there?">
      <div>
        <strong>Are you still there?</strong>
        <div className="st-muted">You will be signed out in {secondsLeft} seconds, to keep your organisation's forms safe.</div>
      </div>
      <Button
        onClick={() => {
          lastActive.current = Date.now();
          setSecondsLeft(null);
          void refreshSession();
        }}
      >
        Stay signed in
      </Button>
    </div>
  );
}
