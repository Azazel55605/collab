interface AppLogoProps {
  size?: number;
  className?: string;
}

export function AppLogo({ size = 24, className }: AppLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Connector lines */}
      <line x1="12" y1="12" x2="12" y2="4"  stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" opacity="0.5" />
      <line x1="12" y1="12" x2="19" y2="16" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" opacity="0.5" />
      <line x1="12" y1="12" x2="5"  y2="16" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" opacity="0.5" />

      {/* Satellite nodes */}
      <circle cx="12" cy="4"  r="2.2" fill="currentColor" opacity="0.7" />
      <circle cx="19" cy="16" r="2.2" fill="currentColor" opacity="0.7" />
      <circle cx="5"  cy="16" r="2.2" fill="currentColor" opacity="0.7" />

      {/* Hub node */}
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </svg>
  );
}
