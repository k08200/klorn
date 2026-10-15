import localFont from "next/font/local";

/**
 * The landing's accent face (Instrument Serif italic, OFL 1.1 — see
 * website/fonts/SOURCE.md), used for one phrase in the sign-in headline so the
 * first click off klorn.ai lands in the same visual language. Self-hosted by
 * next/font: no runtime request, so the CSP stays intact. Latin subset only —
 * CJK headlines keep the UI face (the landing does the same).
 */
export const accentSerif = localFont({
  src: "./instrument-serif-italic.woff2",
  style: "italic",
  weight: "400",
  display: "swap",
  variable: "--font-accent-serif",
  fallback: ["Iowan Old Style", "Georgia", "serif"],
});
