"use client";

import { useCallback, useRef, useState } from "react";

/** Strip markdown formatting for cleaner TTS output */
function stripMarkdown(text: string): string {
  return text
    .replace(/#{1,6}\s+/g, "") // headers
    .replace(/\*\*(.+?)\*\*/g, "$1") // bold
    .replace(/\*(.+?)\*/g, "$1") // italic
    .replace(/`{1,3}[^`]*`{1,3}/g, "") // code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links
    .replace(/^[-*]\s+/gm, "") // bullets
    .replace(/^\d+\.\s+/gm, "") // numbered lists
    .replace(/\n{2,}/g, ". ") // paragraphs to pause
    .replace(/_\[.*?\]_/g, "") // metadata like _[Generation stopped]_
    .trim();
}

interface SpeakButtonProps {
  text: string;
  className?: string;
}

export default function SpeakButton({ text, className }: SpeakButtonProps) {
  const [speaking, setSpeaking] = useState(false);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  const toggle = useCallback(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;

    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }

    const clean = stripMarkdown(text);
    if (!clean) return;

    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.lang = "en-US";
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);

    utteranceRef.current = utterance;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    setSpeaking(true);
  }, [text, speaking]);

  if (typeof window !== "undefined" && !window.speechSynthesis) return null;

  return (
    <button
      type="button"
      onClick={toggle}
      className={`transition ${className || ""} ${
        speaking ? "text-sky-600" : "text-slate-400 hover:text-slate-500"
      }`}
      title={speaking ? "Stop reading" : "Read aloud"}
    >
      <svg
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {speaking ? (
          <>
            <rect x="6" y="4" width="4" height="16" />
            <rect x="14" y="4" width="4" height="16" />
          </>
        ) : (
          <>
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          </>
        )}
      </svg>
    </button>
  );
}
