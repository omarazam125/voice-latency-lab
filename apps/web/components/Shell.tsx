'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { useStore } from '../lib/store';

const NAV = [
  { href: '/', label: 'Console' },
  { href: '/monitor', label: 'Live Monitor' },
  { href: '/turns', label: 'Turns & Waterfall' },
  { href: '/vapi-lab', label: 'Vapi Lab (C)' },
  { href: '/llm-lab', label: 'GPT Lab' },
  { href: '/compare', label: 'Compare' },
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/benchmarks', label: 'Benchmarks' },
  { href: '/knowledge', label: 'Knowledge Base' },
  { href: '/settings', label: 'Settings' },
  { href: '/debug', label: 'Debug' },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const connected = useStore((s) => s.connected);
  const connecting = useStore((s) => s.connecting);
  const status = useStore((s) => s.status);
  const clock = useStore((s) => s.clock);
  const connect = useStore((s) => s.connect);

  // The socket lives at the shell level, so it survives client-side navigation
  // between pages. Switching tabs mid-conversation must not drop the session.
  useEffect(() => {
    connect();
    const t = setInterval(() => {
      if (!useStore.getState().connected && !useStore.getState().connecting) useStore.getState().connect();
    }, 3000);
    return () => clearInterval(t);
  }, [connect]);

  const ready = status?.ready ?? false;
  const readyTone = !connected ? 'bad' : ready ? 'ok' : 'warn';
  const readyText = !connected ? 'DISCONNECTED' : ready ? 'READY' : 'NOT READY';

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          Voice <span>Latency Lab</span>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={pathname === n.href ? 'active' : ''}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="topbar-right">
          {clock && (
            <span className="badge" title="Browser/server clock offset estimate. Uncertainty is half the best round-trip time.">
              clock ±{clock.uncertaintyMs.toFixed(2)}ms
            </span>
          )}
          {status && (
            <span className="badge" title="Pipeline mode currently selected">
              MODE {status.mode}
            </span>
          )}
          <span className={`badge ${readyTone}`}>
            <span className={`dot ${connecting ? 'active' : readyTone}`} />
            {connecting ? 'CONNECTING' : readyText}
          </span>
        </div>
      </header>
      <main className="page">{children}</main>
    </div>
  );
}
