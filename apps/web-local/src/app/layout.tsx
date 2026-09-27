import type { Metadata, Viewport } from 'next';
import { Lato, IBM_Plex_Serif } from 'next/font/google';
import { DOCUMENT_ATTRIBUTES, VIEWPORT } from '@aflow/web-product/ui';
import '@aflow/design-system/styles.css';
import type { ReactNode } from 'react';

// `next/font` is transformed at build time, and the transform reads the options
// from the call itself — an imported constant resolves to nothing and the build
// fails on `next/font/google/target.css`. So these stay written here, in both
// applications, and the reason they agree is this comment rather than a symbol.
//
// IBM Plex Serif powers the `cognitive` register (entity narration, reasoning,
// episodic summaries). Not preloaded: it is declared at the root so the variable
// resolves everywhere, but the surfaces drawing with it are a minority of routes,
// and preloading pushes three files into every document's critical path that most
// pages never use.
const lato = Lato({ weight: ['300', '400', '700'], subsets: ['latin'], variable: '--font-lato' });
const ibmPlexSerif = IBM_Plex_Serif({
  weight: ['400', '500', '600'],
  subsets: ['latin'],
  variable: '--font-ibm-plex-serif',
  preload: false,
});

export const viewport: Viewport = VIEWPORT;

// This instance is not a site: it is not indexed, has no canonical address, and
// the name in a tab belongs to the operator's own machine.
export const metadata: Metadata = {
  title: 'Aflow',
  icons: {
    icon: '/strawberry-robot.svg',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html {...DOCUMENT_ATTRIBUTES} className={`${lato.variable} ${ibmPlexSerif.variable}`}>
      {/* No analytics: an instance on somebody's own machine reports to nobody. */}
      <body>{children}</body>
    </html>
  );
}
