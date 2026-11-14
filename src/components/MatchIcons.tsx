import type { ReactNode } from 'react';

/** The match popup's small glyphs, drawn in the nav icons' stroke so the popup
 *  stops borrowing whatever emoji font the reader's device has. */
function Icon({ children, size = 13 }: { children: ReactNode; size?: number }) {
  return (
    <svg className="mx-icon" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export const PinIcon = () => (
  <Icon><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" /></Icon>
);

export const CrowdIcon = () => (
  <Icon><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0" /><circle cx="17" cy="9" r="2.2" /><path d="M15.5 20a5 5 0 0 1 5.5-4.6" /></Icon>
);

export const BallIcon = ({ size = 11 }: { size?: number }) => (
  <Icon size={size}><circle cx="12" cy="12" r="9" /><path d="M12 7.5l4.3 3.1-1.6 5h-5.4l-1.6-5z" /><path d="M12 3v4.5M20.6 9.3l-4.3 1.3M17.3 19.3l-2.6-3.7M6.7 19.3l2.6-3.7M3.4 9.3l4.3 1.3" /></Icon>
);
