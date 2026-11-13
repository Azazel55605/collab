export function formatTime(seconds: number) {
  const whole = Math.floor(Number.isFinite(seconds) ? seconds : 0);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainder = String(whole % 60).padStart(2, '0');
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}`
    : `${minutes}:${remainder}`;
}

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function speedLabel(rate: number) {
  return rate === 1 ? 'Normal' : `${rate}×`;
}
