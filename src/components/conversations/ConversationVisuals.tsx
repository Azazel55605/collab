import type { CSSProperties, ReactNode } from 'react';

import { useUserAvatar } from '../../lib/userAvatars';
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar';

import { initial, nameHue } from './chatFormat';

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

/** A person's server avatar, falling back to their tinted initial. */
export function UserAvatar({
  serverUrl,
  userId,
  name,
  picture,
  size,
  version,
  children,
}: {
  serverUrl: string;
  userId?: string;
  name: string;
  picture?: string | null;
  size?: 'sm' | 'md' | 'lg';
  version?: string | null;
  children?: ReactNode;
}) {
  const image = useUserAvatar(serverUrl, userId, !picture, version ?? '');
  return (
    <NameAvatar name={name} picture={picture ?? image} size={size}>
      {children}
    </NameAvatar>
  );
}
