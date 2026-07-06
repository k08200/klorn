"use client";

// Speech-to-text input, platform-branched:
//  - Native shell (Capacitor): @capacitor-community/speech-recognition via
//    dynamic import — the WebView has no webkitSpeechRecognition, and the
//    plugin JS only loads inside the shell (web bundle stays plugin-free).
//  - Web: the browser Web Speech API (logic previously in voice-button.tsx).
// Voice is progressive enhancement: unsupported/denied → supported=false and
// the caller hides the mic; typing always works.

import { useCallback, useEffect, useRef, useState } from "react";
import { isNativePlatform } from "./native/capacitor";
import { captureClientError } from "./sentry";

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

function speechLang(): string {
  return navigator.language.startsWith("ko") ? "ko-KR" : "en-US";
}

export function useSpeechInput(onTranscript: (text: string) => void): {
  supported: boolean;
  listening: boolean;
  toggle: () => void;
} {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const isNative = useRef(false);
  const webRecognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const nativeLatestRef = useRef("");
  const callbackRef = useRef(onTranscript);
  callbackRef.current = onTranscript;

  useEffect(() => {
    if (isNativePlatform()) {
      isNative.current = true;
      // Availability is confirmed lazily on first toggle (plugin import +
      // permission prompt belong to a user gesture); assume present in the
      // shell — the shell always ships the plugin.
      setSupported(true);
      // Unmounting mid-dictation must not leave the OS recognizer running
      // with listeners firing into a dead component.
      return () => {
        void import("@capacitor-community/speech-recognition")
          .then(({ SpeechRecognition }) => {
            SpeechRecognition.stop().catch(() => {});
            return SpeechRecognition.removeAllListeners();
          })
          .catch((err) => console.error("[SPEECH] unmount cleanup failed:", err));
      };
    }

    const win = window as unknown as Record<string, unknown>;
    const Ctor = (win.SpeechRecognition || win.webkitSpeechRecognition) as
      | (new () => SpeechRecognitionInstance)
      | undefined;
    setSupported(!!Ctor);
    if (!Ctor) return;

    const recognition = new Ctor();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = speechLang();
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = event.results[0]?.[0]?.transcript;
      if (transcript) callbackRef.current(transcript);
      setListening(false);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    webRecognitionRef.current = recognition;

    // Unmounting mid-dictation must not leave the browser mic running with
    // handlers firing into a dead component.
    return () => {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.stop();
      } catch {
        // stop() on a recognizer that never started throws — nothing to clean.
      }
      webRecognitionRef.current = null;
    };
  }, []);

  const toggleNative = useCallback(async () => {
    const { SpeechRecognition } = await import("@capacitor-community/speech-recognition");

    if (listening) {
      try {
        await SpeechRecognition.stop();
      } catch (err) {
        console.error("[SPEECH] native stop failed:", err);
      }
      // Finalization happens in the listeningState listener below.
      return;
    }

    try {
      const { available } = await SpeechRecognition.available();
      if (!available) {
        console.warn("[SPEECH] native recognizer not available on this device");
        setSupported(false);
        return;
      }
      const perm = await SpeechRecognition.requestPermissions();
      if (perm.speechRecognition !== "granted") {
        // Distinct from "unavailable": the user denied the OS prompt. Leave a
        // trace so "mic disappeared" reports are diagnosable.
        console.warn("[SPEECH] microphone/speech permission denied by the user");
        captureClientError(new Error("speech permission denied"), { scope: "speech.permission" });
        setSupported(false);
        return;
      }

      nativeLatestRef.current = "";
      await SpeechRecognition.removeAllListeners();
      await SpeechRecognition.addListener("partialResults", (data: { matches?: string[] }) => {
        const text = data.matches?.[0];
        if (text) nativeLatestRef.current = text;
      });
      await SpeechRecognition.addListener(
        "listeningState",
        (data: { status?: "started" | "stopped" }) => {
          if (data.status !== "stopped") return;
          setListening(false);
          const text = nativeLatestRef.current.trim();
          nativeLatestRef.current = "";
          if (text) callbackRef.current(text);
          SpeechRecognition.removeAllListeners().catch(() => {});
        },
      );

      setListening(true);
      await SpeechRecognition.start({
        language: speechLang(),
        partialResults: true,
        popup: false,
      });
    } catch (err) {
      console.error("[SPEECH] native recognition failed:", err);
      setListening(false);
    }
  }, [listening]);

  const toggle = useCallback(() => {
    if (isNative.current) {
      void toggleNative();
      return;
    }

    const recognition = webRecognitionRef.current;
    if (!recognition) return;
    if (listening) {
      recognition.stop();
      setListening(false);
    } else {
      recognition.start();
      setListening(true);
    }
  }, [listening, toggleNative]);

  return { supported, listening, toggle };
}
