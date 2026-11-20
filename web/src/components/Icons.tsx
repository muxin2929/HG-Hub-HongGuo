import type { CSSProperties, ReactElement } from 'react';

type IconName =
  | 'home' | 'theater' | 'coin' | 'user' | 'search' | 'menu' | 'moon' | 'heart' | 'heartFill'
  | 'chat' | 'share' | 'star' | 'starFill' | 'chevron' | 'play' | 'funnel' | 'flame' | 'calendar'
  | 'camera' | 'settings' | 'scan' | 'wallet' | 'download' | 'feedback' | 'check' | 'back'
  | 'close' | 'fullscreen' | 'bullet' | 'mute' | 'vol' | 'info' | 'fire' | 'smile' | 'more' | 'expand' | 'trophy' | 'sun' | 'pause' | 'speed' | 'lock' | 'trash' | 'clock';

const P: Record<IconName, ReactElement> = {
  home: <><path d="M3.2 10.2 12 3.3l8.8 6.9" /><path d="M5.6 9.4V20a.8.8 0 0 0 .8.8h11.2a.8.8 0 0 0 .8-.8V9.4" /></>,
  theater: <><rect x="3" y="4.5" width="18" height="15" rx="2.4" /><path d="M10.2 9.2 15 12l-4.8 2.8V9.2Z" /></>,
  coin: <><circle cx="12" cy="12" r="8.4" /><path d="M9.6 9.2h4.8M9.6 12h4.8M12 8v8" /></>,
  user: <><circle cx="12" cy="8" r="3.7" /><path d="M4.6 20.4a7.4 7.4 0 0 1 14.8 0" /></>,
  search: <><circle cx="11" cy="11" r="6.6" /><path d="M20 20l-4.4-4.4" /></>,
  menu: <><path d="M3.6 6.5h16.8M3.6 12h16.8M3.6 17.5h16.8" /></>,
  moon: <path d="M20 14.6A8.6 8.6 0 0 1 9.4 4a8.6 8.6 0 1 0 10.6 10.6Z" />,
  heart: <path d="M12 20.2s-7.6-4.6-7.6-9.6a4.3 4.3 0 0 1 7.6-2.7 4.3 4.3 0 0 1 7.6 2.7c0 5-7.6 9.6-7.6 9.6Z" />,
  heartFill: <path d="M12 20.2s-7.6-4.6-7.6-9.6a4.3 4.3 0 0 1 7.6-2.7 4.3 4.3 0 0 1 7.6 2.7c0 5-7.6 9.6-7.6 9.6Z" fill="currentColor" stroke="none" />,
  chat: <><path d="M20.6 11.6a8 8 0 0 1-.9 3.7 8.2 8.2 0 0 1-7.3 4.5 8 8 0 0 1-3.7-.9L3.4 20.6l1.7-5.3a8 8 0 0 1-.9-3.7 8.2 8.2 0 0 1 4.5-7.3 8 8 0 0 1 3.7-.9h.5a8.2 8.2 0 0 1 7.7 7.7v.5Z" /></>,
  share: <><path d="M14.6 4.4 20 9.8l-5.4 5.4" /><path d="M20 9.8H9.4A5.4 5.4 0 0 0 4 15.2v4.4" /></>,
  star: <path d="m12 3.4 2.7 5.5 6.1.9-4.4 4.3 1 6-5.4-2.9-5.4 2.9 1-6L3.2 9.8l6.1-.9L12 3.4Z" />,
  starFill: <path d="m12 3.4 2.7 5.5 6.1.9-4.4 4.3 1 6-5.4-2.9-5.4 2.9 1-6L3.2 9.8l6.1-.9L12 3.4Z" fill="currentColor" stroke="none" />,
  chevron: <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />,
  play: <path d="M8.4 5.6 18 12l-9.6 6.4V5.6Z" />,
  trash: <><path d="M4.6 6.8h14.8" /><path d="M9.2 6.8V4.9a1.3 1.3 0 0 1 1.3-1.3h3a1.3 1.3 0 0 1 1.3 1.3v1.9" /><path d="M6.6 6.8l.9 12.6a1.6 1.6 0 0 0 1.6 1.5h5.8a1.6 1.6 0 0 0 1.6-1.5l.9-12.6" /><path d="M10.4 10.6v6.2M13.6 10.6v6.2" /></>,
  lock: <><rect x="5" y="10.6" width="14" height="9.4" rx="2.2" /><path d="M8.4 10.6V7.8a3.6 3.6 0 0 1 7.2 0v2.8" /></>,
  clock: <><circle cx="12" cy="12" r="8.4" /><path d="M12 7.2V12l3.4 2.1" /></>,
  speed: <><circle cx="12" cy="12" r="8.4" /><path d="M12 7.6V12l3 1.8" /><path d="M18.2 5.2v-2h2" /></>,
  pause: <><rect x="7.4" y="5.4" width="3.4" height="13.2" rx="1" fill="currentColor" stroke="none" /><rect x="13.2" y="5.4" width="3.4" height="13.2" rx="1" fill="currentColor" stroke="none" /></>,
  funnel: <><path d="M4 5.4h16l-6.2 7.4V20l-3.6-2v-5.2L4 5.4Z" /></>,
  flame: <path d="M12.2 3.2c.3 3-1.3 4.3-2.6 5.8-1.2 1.4-2.2 2.8-2.2 4.8A5.3 5.3 0 0 0 12 19.8a5 5 0 0 0 5-5c0-4.2-4.8-6-4.8-11.6Z" />,
  fire: <path d="M12.2 3.2c.3 3-1.3 4.3-2.6 5.8-1.2 1.4-2.2 2.8-2.2 4.8A5.3 5.3 0 0 0 12 19.8a5 5 0 0 0 5-5c0-4.2-4.8-6-4.8-11.6Z" />,
  calendar: <><rect x="3.4" y="5.4" width="17.2" height="15" rx="2.4" /><path d="M3.4 10h17.2M8 3.4v4M16 3.4v4" /></>,
  camera: <><path d="M4 8.4h3l1.4-2.2h7.2L17 8.4h3a1.4 1.4 0 0 1 1.4 1.4v8.2A1.4 1.4 0 0 1 20 19.4H4a1.4 1.4 0 0 1-1.4-1.4V9.8A1.4 1.4 0 0 1 4 8.4Z" /><circle cx="12" cy="13.6" r="3" /></>,
  settings: <><circle cx="12" cy="12" r="3.2" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a1.9 1.9 0 1 1-3.8 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a1.9 1.9 0 1 1 0-3.8h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a1.9 1.9 0 1 1 3.8 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a1.9 1.9 0 1 1 0 3.8h-.1a1.6 1.6 0 0 0-1.5 1Z" /></>,
  scan: <><path d="M4 9V5.6A1.6 1.6 0 0 1 5.6 4H9M15 4h3.4A1.6 1.6 0 0 1 20 5.6V9M20 15v3.4a1.6 1.6 0 0 1-1.6 1.6H15M9 20H5.6A1.6 1.6 0 0 1 4 18.4V15M3.6 12h16.8" /></>,
  wallet: <><rect x="3.2" y="6" width="17.6" height="13.6" rx="2.6" /><path d="M3.2 10.4h17.6M16 15.2h1.6" /></>,
  download: <><path d="M12 3.6v11.2" /><path d="m7.6 10.8 4.4 4.4 4.4-4.4" /><path d="M4 18.4v1.2a.8.8 0 0 0 .8.8h14.4a.8.8 0 0 0 .8-.8v-1.2" /></>,
  feedback: <><path d="M20.4 12.8a7.6 7.6 0 0 1-8.2 7.6 7.6 7.6 0 0 1-3.4-.9L4 20.6l1.2-4.6a7.6 7.6 0 0 1-1-3.9 7.6 7.6 0 0 1 7.6-7.3 7.6 7.6 0 0 1 8.6 8Z" /><path d="M12 8.4v4M12 15.4h.01" /></>,
  check: <path d="m4.8 12.6 4.6 4.6 9.8-10" />,
  back: <path d="M14.5 5.5 8 12l6.5 6.5" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  fullscreen: <><path d="M9 4H4v5M15 4h5v5M20 15v5h-5M4 15v5h5" /></>,
  bullet: <><rect x="3.2" y="5" width="17.6" height="14" rx="3" /><path d="M7.6 9.6v4.8M11.4 9.6h4.8M11.4 14.4h4.8" /></>,
  mute: <><path d="M11 5.2 6.6 8.6H3.6v6.8h3l4.4 3.4V5.2Z" /><path d="m16.4 9.4 4.2 5.2M20.6 9.4l-4.2 5.2" /></>,
  vol: <><path d="M11 5.2 6.6 8.6H3.6v6.8h3l4.4 3.4V5.2Z" /><path d="M15.4 8.6a5 5 0 0 1 0 6.8M18.2 6.2a8.6 8.6 0 0 1 0 11.6" /></>,
  info: <><circle cx="12" cy="12" r="8.6" /><path d="M12 10.8v5.6M12 8h.01" /></>,
  smile: <><circle cx="12" cy="12" r="8.6" /><path d="M8.4 14.2a4.2 4.2 0 0 0 7.2 0" /><path d="M9 9.6h.01M15 9.6h.01" /></>,
  more: <><circle cx="12" cy="5.4" r="1.5" fill="currentColor" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /><circle cx="12" cy="18.6" r="1.5" fill="currentColor" /></>,
  expand: <><path d="M14.5 4h5.5v5.5M9.5 20H4v-5.5M20 4l-6.6 6.6M4 20l6.6-6.6" /></>,
  trophy: <><path d="M7 4h10v5.5a5 5 0 0 1-10 0V4Z" /><path d="M7 5.5H4.3a2.9 2.9 0 0 0 2.9 4.9M17 5.5h2.7a2.9 2.9 0 0 1-2.9 4.9" /><path d="M12 14.5V18" /><path d="M8 20.5h8" /></>,
  sun: <><circle cx="12" cy="12" r="4.2" /><path d="M12 2.6v2.4M12 19v2.4M2.6 12h2.4M19 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7M18.7 5.3 17 7M7 17l-1.7 1.7" /></>,
};

export function Icon({
  name,
  size = 22,
  className = '',
  style,
  strokeWidth = 1.7,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
  strokeWidth?: number;
}) {
  return (
    <svg
      className={`ic ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden="true"
    >
      {P[name]}
    </svg>
  );
}

export type { IconName };
