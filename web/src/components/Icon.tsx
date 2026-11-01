// Stroke icons used across the support workspace (24px grid, drawn with currentColor).
const PATHS: Record<string, string[]> = {
  sms: ['M4 5h16v11H8l-4 4z'],
  email: ['M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'm3 7 9 6 9-6'],
  voice: ['M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z'],
  chat: ['M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12z'],
  note: ['M5 4h10l4 4v12H5z', 'M15 4v4h4'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  check: ['m5 12 5 5L20 7'],
  inbox: ['M3 13h5l2 3h4l2-3h5', 'M5 5h14l2 8v6H3v-6z'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21a8 8 0 0 1 16 0'],
  alert: ['M12 3 2 21h20z', 'M12 10v4', 'M12 17h.01'],
  at: ['M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1'],
  question: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7', 'M12 17h.01'],
  home: ['M3 11 12 4l9 7v9H3z', 'M10 20v-5h4v5'],
  key: ['M8 19a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'm11 12 9-9', 'm17 6 3 3'],
  calendar: ['M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z', 'M3 10h18', 'M8 3v4', 'M16 3v4'],
  star: ['m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z'],
  money: ['M12 3v18', 'M16 7h-6a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6H8'],
  send: ['m4 12 16-8-6 16-3-7z'],
  bolt: ['M13 3 4 14h7l-1 7 9-11h-7z'],
  lock: ['M6 11h12v10H6z', 'M8 11V8a4 4 0 0 1 8 0v3'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'm20 20-3.5-3.5'],
  back: ['m15 5-7 7 7 7'],
  pin: ['M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z', 'M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'],
  // Sidebar navigation
  headset: ['M4 15v-3a8 8 0 0 1 16 0v3', 'M4 14h3v5H5a1 1 0 0 1-1-1z', 'M20 14h-3v5h2a1 1 0 0 0 1-1z'],
  flask: ['M9 3h6', 'M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3', 'M7.3 15h9.4'],
  sliders: ['M4 7h9', 'M17 7h3', 'M4 17h3', 'M11 17h9', 'M15 5v4', 'M9 15v4'],
  grid: ['M4 4h7v7H4z', 'M13 4h7v4h-7z', 'M13 10h7v10h-7z', 'M4 13h7v7H4z'],
  truck: ['M3 6h11v10H3z', 'M14 10h4l3 3v3h-7', 'M7 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M17 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
  route: ['M6 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M18 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M8 19h8.5a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H16'],
  file: ['M6 3h9l4 4v14H6z', 'M14 3v5h5', 'M9 13h7', 'M9 17h5'],
  users: ['M12 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M6 20a6 6 0 0 1 12 0', 'M5.5 11a2.5 2.5 0 1 1 0-5', 'M18.5 11a2.5 2.5 0 1 0 0-5', 'M2 18a4 4 0 0 1 3-3.8', 'M22 18a4 4 0 0 0-3-3.8'],
  trend: ['M3 17l6-6 4 4 8-8', 'M15 7h6v6'],
  card: ['M3 6h18v12H3z', 'M3 10h18', 'M7 15h4'],
  'alert-circle': ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 8v5', 'M12 16h.01'],
  wallet: ['M4 7h15a1 1 0 0 1 1 1v11H4z', 'M4 7V6a2 2 0 0 1 2-2h11', 'M16 13h1'],
  percent: ['M19 5 5 19', 'M7 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
  gift: ['M4 11h16v10H4z', 'M3 7h18v4H3z', 'M12 7v14', 'M12 7C10.5 4 7 4 7 6s3 1 5 1z', 'M12 7c1.5-3 5-3 5-1s-3 1-5 1z'],
  sparkle: ['m12 3 1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7-4.7-1.8 4.7-1.8z', 'm19 15 .8 2.2 2.2.8-2.2.8L19 21l-.8-2.2-2.2-.8 2.2-.8z'],
  'plus-square': ['M4 4h16v16H4z', 'M12 8v8', 'M8 12h8'],
  repeat: ['M4 12a8 8 0 0 1 14-5.3', 'M18 3v4h-4', 'M20 12a8 8 0 0 1-14 5.3', 'M6 21v-4h4'],
  receipt: ['M6 3h12v18l-3-2-3 2-3-2-3 2z', 'M9 8h6', 'M9 12h6', 'M9 16h3'],
  'calendar-x': ['M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z', 'M3 10h18', 'M8 3v4', 'M16 3v4', 'm10 13 4 4', 'm14 13-4 4'],
  tag: ['M3 12V4h8l10 10-8 8z', 'M7.5 8.5h.01'],
  badge: ['M5 4h14v17H5z', 'M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M8 17a4 4 0 0 1 8 0'],
  'mail-x': ['M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8', 'm3 7 9 6 9-6', 'm17 16 4 4', 'm21 16-4 4'],
  code: ['m8 8-4 4 4 4', 'm16 8 4 4-4 4', 'm14 5-4 14'],
  bell: ['M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z', 'M10 21h4'],
  logout: ['M14 4H5v16h9', 'm17 8 4 4-4 4', 'M21 12H10'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h10'],
  close: ['m6 6 12 12', 'M18 6 6 18'],
  chevron: ['m9 6 6 6-6 6'],
  'chevron-down': ['m6 9 6 6 6-6'],
  'panel-close': ['M4 5h16v14H4z', 'M9.5 5v14', 'm16 10-2 2 2 2'],
  'panel-open': ['M4 5h16v14H4z', 'M9.5 5v14', 'm14 10 2 2-2 2'],
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, label, className }: { name: IconName | string; size?: number; label?: string; className?: string }) {
  const paths = PATHS[name] || PATHS.note;
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
