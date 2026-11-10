/**
 * In-app purchase through RevenueCat (ported from the web's
 * lib/native/iap.ts). Apple and Google require a digital subscription to be
 * sold through StoreKit / Play Billing inside the app (App Store 3.1.1), so
 * the app never shows a web checkout or an external purchase link. RevenueCat
 * reconciles the entitlement to the server by webhook (revenuecat-webhook.ts),
 * which sets user.plan like the web's checkout does.
 *
 * Inert until running natively AND VITE_REVENUECAT_IOS_KEY /
 * VITE_REVENUECAT_ANDROID_KEY is set at build time (mobile-release.yml passes
 * both). Mock builds only: `?iap=ios` / `?iap=android` fakes a store with one
 * monthly offer, so the Plans disclosures can be seen and tested in a browser.
 */
import { MOCK_API } from "../config";
import { type SubscriptionLength, subscriptionLengthOf } from "../screens/settings/plans-model";
import { platformName } from "./native";

const IOS_KEY = (import.meta.env.VITE_REVENUECAT_IOS_KEY as string | undefined) ?? "";
const ANDROID_KEY = (import.meta.env.VITE_REVENUECAT_ANDROID_KEY as string | undefined) ?? "";

const MOCK_STORE_KEY = "klorn-mock-iap";

/** Mock builds: the faked store, from `?iap=` (remembered for the tab). Always null in real builds. */
function mockStore(): "ios" | "android" | null {
  if (!MOCK_API || typeof window === "undefined") return null;
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("iap");
    if (fromUrl === "ios" || fromUrl === "android") {
      window.sessionStorage.setItem(MOCK_STORE_KEY, fromUrl);
    }
    const stored = window.sessionStorage.getItem(MOCK_STORE_KEY);
    return stored === "ios" || stored === "android" ? stored : null;
  } catch {
    return null;
  }
}

function keyForPlatform(): string {
  const platform = platformName();
  if (platform === "ios") return IOS_KEY;
  if (platform === "android") return ANDROID_KEY;
  return "";
}

/** True only natively with a RevenueCat key configured. */
export function iapAvailable(): boolean {
  return mockStore() !== null || keyForPlatform().length > 0;
}

/** Which store sells the subscription here (its cancel path differs), or null without IAP. */
export function storePlatform(): "ios" | "android" | null {
  const mock = mockStore();
  if (mock) return mock;
  const platform = platformName();
  return iapAvailable() && platform !== "web" ? platform : null;
}

let configuredFor: string | null = null;

async function loadPurchases(appUserId: string) {
  const apiKey = keyForPlatform();
  if (!apiKey) return null;
  const { Purchases } = await import("@revenuecat/purchases-capacitor");
  if (configuredFor === null) {
    // Our own user id, so the webhook maps the purchase back to the account.
    await Purchases.configure({ apiKey, appUserID: appUserId });
    configuredFor = appUserId;
  } else if (configuredFor !== appUserId) {
    await Purchases.logIn({ appUserID: appUserId });
    configuredFor = appUserId;
  }
  return Purchases;
}

export interface StoreOffer {
  /** The store's own localized price ("₩14,000" comes from the store, never from us). */
  priceString: string;
  /** The product's name in the store (App Store Connect / Play Console). */
  title: string;
  /** How long one period is (package type, else the ISO period); null if the store says nothing. */
  length: SubscriptionLength | null;
}

/** The current offering's first package — what "Subscribe" buys. */
export async function currentOffer(appUserId: string): Promise<StoreOffer | null> {
  if (mockStore()) {
    return { priceString: "₩14,000", title: "Klorn Pro", length: { unit: "month", count: 1 } };
  }
  try {
    const Purchases = await loadPurchases(appUserId);
    if (!Purchases) return null;
    const offerings = await Purchases.getOfferings();
    const pkg = offerings.current?.availablePackages?.[0];
    if (!pkg) return null;
    return {
      priceString: pkg.product.priceString,
      title: pkg.product.title,
      length: subscriptionLengthOf(pkg.packageType, pkg.product.subscriptionPeriod),
    };
  } catch {
    return null;
  }
}

export type PurchaseOutcome = "purchased" | "cancelled" | "unavailable" | "error";

export async function startNativePurchase(appUserId: string): Promise<PurchaseOutcome> {
  if (mockStore()) return "cancelled";
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
    return "error";
  }
}

/** Restore (Apple requires it to be reachable). True when any entitlement is active afterwards. */
export async function restoreNativePurchases(appUserId: string): Promise<boolean> {
  if (mockStore()) return false;
  try {
    const Purchases = await loadPurchases(appUserId);
    if (!Purchases) return false;
    const { customerInfo } = await Purchases.restorePurchases();
    return Object.keys(customerInfo.entitlements.active).length > 0;
  } catch {
    return false;
  }
}

/** The store's own subscription page (Apple / Google), when the store gives one. */
export async function managementUrl(appUserId: string): Promise<string | null> {
  if (mockStore()) return null;
  try {
    const Purchases = await loadPurchases(appUserId);
    if (!Purchases) return null;
    const { customerInfo } = await Purchases.getCustomerInfo();
    return customerInfo.managementURL ?? null;
  } catch {
    return null;
  }
}
