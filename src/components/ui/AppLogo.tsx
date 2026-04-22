import { useUiStore } from '../../store/uiStore';

interface AppLogoProps {
  size?: number;
  className?: string;
}

export function AppLogo({ size = 24, className }: AppLogoProps) {
  const theme = useUiStore((state) => state.theme);
  const isLight = theme === 'light';
  const backCardOpacity = isLight ? 0.14 : 0.10;
  const frontCardOpacity = isLight ? 0.18 : 0.14;
  const secondaryStrokeOpacity = isLight ? 0.84 : 0.72;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <rect x="7" y="10" width="30" height="34" rx="8" fill="currentColor" opacity={backCardOpacity} />
      <rect x="18" y="6" width="30" height="34" rx="8" fill="currentColor" opacity={frontCardOpacity} />
      <path
        d="M35 8H45V18"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M25 24H39"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M25 30H34"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        opacity={secondaryStrokeOpacity}
      />
    </svg>
  );
}
