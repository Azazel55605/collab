import type { CSSProperties, ReactNode } from 'react';

import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar';

/** Stable hue per name so the same person keeps the same tint everywhere. */
export function nameHue(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) % 360;
  return hash;
}
export function initial(name: string) {
  return (name.trim()[0] ?? '?').toUpperCase();
}
export function NameAvatar({
  name,
  picture,
  size = 'md',
  square = false,
  children,
}: {
  name: string;
  picture?: string | null;
  size?: 'sm' | 'md' | 'lg';
  square?: boolean;
  children?: ReactNode;
}) {
  return (
    <Avatar
      className={`conversation-avatar ${size} ${square ? 'square' : ''}`}
      style={{ '--avatar-hue': nameHue(name) } as CSSProperties}
    >
      {picture && <AvatarImage src={picture} alt="" />}
      <AvatarFallback>{children ?? initial(name)}</AvatarFallback>
    </Avatar>
  );
}

function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}
/** Teams-style list time: clock today, "Yesterday", weekday this week, else a date. */
export function listTime(timestamp: number, now = Date.now()) {
  const at = new Date(timestamp);
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return at.toLocaleDateString([], { weekday: 'short' });
  return at.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
export function messageTime(timestamp: number, now = Date.now()) {
  const at = new Date(timestamp);
  const clock = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return startOfDay(at) === startOfDay(new Date(now))
    ? clock
    : `${listTime(timestamp, now)} ${clock}`;
}
