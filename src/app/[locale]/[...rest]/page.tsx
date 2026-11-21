import { notFound } from 'next/navigation';

// An address no route matches would otherwise skip the locale layout and get
// Next's bare 404. Matching it here hands it to ../not-found.tsx instead.
export default function UnmatchedRoute() {
  notFound();
}
