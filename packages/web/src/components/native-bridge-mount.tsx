"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { isNativePlatform } from "../lib/native/capacitor";

// The Capacitor shell's app-wide wiring (splash, Android back, keyboard,
// account-link deep links) — its own chunk, never loaded on the web.
const NativeBridge = dynamic(() => import("../lib/native/native-bridge"), { ssr: false });

/** Renders nothing on the web; inside the Capacitor shell, the native bridge. */
export default function NativeBridgeMount() {
  const [native, setNative] = useState(false);
  useEffect(() => {
    setNative(isNativePlatform());
  }, []);
  return native ? <NativeBridge /> : null;
}
