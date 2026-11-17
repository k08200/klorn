/**
 * MonogramAvatar — a sender's initials on a hue drawn from the name, the
 * notification center's monogram (lib/notification-center.ts, monogram()).
 * White initials stay above 4.5:1 on every hue at this lightness
 * (notification-row.tsx). Decorative: the name is always written beside it,
 * so the avatar is hidden from assistive technology.
 *
 * Sizes follow the MB1 boards (mobile redesign, LOCKED 2026-11-14): 34px on a
 * mail row, 30px on a Today card and the reader's sender line.
 */

import { monogram } from "../../lib/notification-center";

const AVATAR_SAT = 28;
const AVATAR_LIGHT = 34;

const SIZE_CLASS = {
  30: "size-7.5",
  34: "size-8.5",
} as const;

export interface MonogramAvatarProps {
  name: string;
  size?: keyof typeof SIZE_CLASS;
  className?: string;
  testId?: string;
}

export function MonogramAvatar({ name, size = 30, className = "", testId }: MonogramAvatarProps) {
  const { initials, hue } = monogram(name);
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      className={`avatar-ring flex shrink-0 items-center justify-center rounded-full text-role-caption font-semibold ${SIZE_CLASS[size]} ${className}`}
      style={{
        backgroundColor: `hsl(${hue} ${AVATAR_SAT}% ${AVATAR_LIGHT}%)`,
        color: "hsl(0 0% 100%)",
      }}
    >
      {initials}
    </span>
  );
}

export default MonogramAvatar;
