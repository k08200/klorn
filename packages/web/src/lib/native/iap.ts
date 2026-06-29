// In-app purchase for the iOS/Android Capacitor shell, via RevenueCat.
//
// Apple/Google require digital subscriptions to be sold through StoreKit / Play
// Billing — not Stripe — inside the app. RevenueCat wraps both and reconciles
// entitlement to our server via webhook (revenuecat-webhook.ts), which sets
// user.plan exactly like the Stripe webhook does for web.
//
// Inert until both (a) running natively and (b) NEXT_PUBLIC_REVENUECAT_*_KEY is
// set, so this is safe to ship before the RevenueCat account exists. On the web
// the dynamic import is never reached.

import { captureClientError } from "../sentry";
import { nativePlatform } from "./capacitor";

const IOS_KEY = process.env.NEXT_PUBLIC_REVENUECAT_IOS_KEY || "";
const ANDROID_KEY = process.env.NEXT_PUBLIC_REVENUECAT_ANDROID_KEY || "";

function keyForPlatform(): string {
  const platform = nativePlatform();
  if (platform === "ios") return IOS_KEY;
  if (platform === "android") return ANDROID_KEY;
  return "";
}

/** True only when running natively AND a RevenueCat key is configured. */
export function iapAvailable(): boolean {
  return keyForPlatform().length > 0;
}

// Configure once; re-identify if the signed-in user changes. RevenueCat ties
// purchases to appUserID — we use our own user id so the webhook can map the
// purchase back to the account.
let configuredFor: string | null = null;

async function loadPurchases(appUserId: string) {
  const apiKey = keyForPlatform();
  if (!apiKey) return null;
  const { Purchases } = await import("@revenuecat/purchases-capacitor");
  if (configuredFor === null) {
    await Purchases.configure({ apiKey, appUserID: appUserId });
    configuredFor = appUserId;
  } else if (configuredFor !== appUserId) {
    await Purchases.logIn({ appUserID: appUserId });
    configuredFor = appUserId;
  }
  return Purchases;
}

export type PurchaseOutcome = "purchased" | "cancelled" | "unavailable" | "error";

/** Start the native subscription purchase (first available package of the
 *  current offering — configure the trial/intro offer on that product in App
 *  Store Connect + RevenueCat). */
export async function startNativePurchase(appUserId: string): Promise<PurchaseOutcome> {
  try {
    const Purchases = await loadPurchases(appUserId);
    if (!Purchases) return "unavailable";
    const offerings = await Purchases.getOfferings();
    const pkg = offerings.current?.availablePackages?.[0];
    if (!pkg) return "unavailable";
    await Purchases.purchasePackage({ aPackage: pkg });
    return "purchased";
  } catch (err) {
    if ((err as { userCancelled?: boolean })?.userCancelled) return "cancelled";
    captureClientError(err, { scope: "iap.purchase" });
    return "error";
  }
}

/** Restore a prior purchase (Apple requires this to be reachable). Returns true
 *  if the user has any active entitlement afterward. */
export async function restoreNativePurchases(appUserId: string): Promise<boolean> {
  try {
    const Purchases = await loadPurchases(appUserId);
    if (!Purchases) return false;
    const { customerInfo } = await Purchases.restorePurchases();
    return Object.keys(customerInfo.entitlements.active).length > 0;
  } catch (err) {
    captureClientError(err, { scope: "iap.restore" });
    return false;
  }
}
