import type { Metadata } from 'next';
import './globals.css';
import { Shell } from '../components/Shell';

export const metadata: Metadata = {
  title: 'Voice Latency Lab',
  description: 'Measure, visualise and compare latency in a realtime AI call-centre voice pipeline.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
