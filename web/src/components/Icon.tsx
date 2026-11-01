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
