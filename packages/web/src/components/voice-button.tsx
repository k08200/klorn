"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Web Speech API types (not in all TS libs)
interface SpeechRecognitionEvent extends Event {
  results: { [index: number]: { [index: number]: { transcript: string } } };
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

interface VoiceButtonProps {
  onTranscript: (text: string) => void;
  className?: string;
}

export default function VoiceButton({ onTranscript, className }: VoiceButtonProps) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const callbackRef = useRef(onTranscript);
  callbackRef.current = onTranscript;

  useEffect(() => {
    const win = window as unknown as Record<string, unknown>;
    const SpeechRecognitionCtor = (win.SpeechRecognition || win.webkitSpeechRecognition) as
      | (new () => SpeechRecognitionInstance)
      | undefined;
    setSupported(!!SpeechRecognitionCtor);

    if (SpeechRecognitionCtor) {
      const recognition = new SpeechRecognitionCtor();
      recognition.continuous = false;
      recognition.interimResults = false;
      // Auto-detect language (Korean + English)
      recognition.lang = navigator.language.startsWith("ko") ? "ko-KR" : "en-US";

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        const transcript = event.results[0]?.[0]?.transcript;
        if (transcript) {
          callbackRef.current(transcript);
        }
        setListening(false);
      };

      recognition.onerror = () => {
        setListening(false);
      };

      recognition.onend = () => {
        setListening(false);
      };

      recognitionRef.current = recognition;
    }
  }, []);

  const toggle = useCallback(() => {
    if (!recognitionRef.current) return;

    if (listening) {
      recognitionRef.current.stop();
      setListening(false);
    } else {
      recognitionRef.current.start();
      setListening(true);
    }
  }, [listening]);

  if (!supported) return null;

  return (
    <button
      type="button"
      onClick={toggle}
      className={`transition ${className || ""} ${
        listening ? "text-red-400 animate-pulse" : "text-stone-500 hover:text-white"
      }`}
      title={listening ? "Stop listening" : "Voice command"}
      aria-label={listening ? "Stop listening" : "Voice command"}
    >
      <svg
        aria-hidden="true"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
        <line x1="8" y1="23" x2="16" y2="23" />
      </svg>
    </button>
  );
}
