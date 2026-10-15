/**
 * Whether to offer iPhone users the "Add to Home Screen" hint.
 *
 * iOS Safari never fires `beforeinstallprompt`, and iOS delivers web push only
 * to an installed web app (display-mode: standalone), so Safari users get
 * manual instructions instead. Pure so the gating is unit-tested; the caller
 * reads the browser state.
 */

export const IOS_INSTALL_DISMISSED_KEY = "klorn-ios-install-dismissed";

/** A dismissal keeps the hint away for a week. */
export const IOS_INSTALL_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

const IOS_DEVICE = /iPad|iPhone|iPod/;

// Chrome/Firefox/Edge on iOS and in-app browsers (Google app, Facebook, Line,
// KakaoTalk) cannot add a web app to the Home Screen, so the steps would be
// wrong there.
const CANNOT_INSTALL = /CriOS|FxiOS|EdgiOS|GSA|FBAN|FBAV|\bLine\/|KAKAOTALK/;

export interface IosInstallContext {
  userAgent: string;
  /** Already running as an installed web app. */
  standalone: boolean;
  /** Inside a native wrapper (Capacitor app, desktop shell): already installed. */
  native: boolean;
  /** Epoch ms of the last dismissal; 0 when never dismissed. */
  dismissedAt: number;
  now: number;
}

export function shouldOfferIosInstall(ctx: IosInstallContext): boolean {
  if (ctx.native || ctx.standalone) return false;
  if (!IOS_DEVICE.test(ctx.userAgent)) return false;
  if (CANNOT_INSTALL.test(ctx.userAgent)) return false;
  if (ctx.dismissedAt > 0 && ctx.now - ctx.dismissedAt < IOS_INSTALL_SNOOZE_MS) return false;
  return true;
}
