/**
 * Voice input for the assistant's composer (ported from the web's
 * lib/use-speech-input.ts). Native: @capacitor-community/speech-recognition —
 * probed with available(), because on iOS the plugin ships only as a
 * CocoaPods podspec and is not linked under Capacitor 8's SPM build, so it
 * rejects there and the mic hides. Browser: the Web Speech API. Unsupported
 * or denied → `supported` is false and the caller hides the mic; typing
 * always works. The OS recognizer hears the audio; the app gets only text.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { isNative } from "./native";

interface WebRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult:
    | ((event: { results: { [i: number]: { [j: number]: { transcript: string } } } }) => void)
    | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

export function useSpeechInput(
  lang: string,
  onTranscript: (text: string) => void,
): { supported: boolean; listening: boolean; toggle: () => void } {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const web = useRef<WebRecognition | null>(null);
  const latest = useRef("");
  const callback = useRef(onTranscript);
  callback.current = onTranscript;

  useEffect(() => {
    if (isNative()) {
      void import("@capacitor-community/speech-recognition")
        .then(({ SpeechRecognition }) => SpeechRecognition.available())
        .then((r) => setSupported(Boolean(r?.available)))
        .catch(() => setSupported(false));
      return () => {
        void import("@capacitor-community/speech-recognition")
          .then(({ SpeechRecognition }) => {
            SpeechRecognition.stop().catch(() => {});
            return SpeechRecognition.removeAllListeners();
          })
          .catch(() => {});
      };
    }
    const w = window as unknown as Record<string, unknown>;
    const Ctor = (w.SpeechRecognition || w.webkitSpeechRecognition) as
      | (new () => WebRecognition)
      | undefined;
    setSupported(Boolean(Ctor));
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = lang;
    recognition.onresult = (event) => {
      const text = event.results[0]?.[0]?.transcript;
      if (text) callback.current(text);
      setListening(false);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    web.current = recognition;
    return () => {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.stop();
      } catch {
        // never started
      }
      web.current = null;
    };
  }, [lang]);

  const toggleNative = useCallback(async () => {
    const { SpeechRecognition } = await import("@capacitor-community/speech-recognition");
    if (listening) {
      await SpeechRecognition.stop().catch(() => {});
      return;
    }
    try {
      const { available } = await SpeechRecognition.available();
      if (!available) {
        setSupported(false);
        return;
      }
      const perm = await SpeechRecognition.requestPermissions();
      if (perm.speechRecognition !== "granted") {
        setSupported(false);
        return;
      }
      latest.current = "";
      await SpeechRecognition.removeAllListeners();
      await SpeechRecognition.addListener("partialResults", (data: { matches?: string[] }) => {
        const text = data.matches?.[0];
        if (text) latest.current = text;
      });
      await SpeechRecognition.addListener(
        "listeningState",
        (data: { status?: "started" | "stopped" }) => {
          if (data.status !== "stopped") return;
          setListening(false);
          const text = latest.current.trim();
          latest.current = "";
          if (text) callback.current(text);
          SpeechRecognition.removeAllListeners().catch(() => {});
        },
      );
      setListening(true);
      await SpeechRecognition.start({ language: lang, partialResults: true, popup: false });
    } catch {
      setListening(false);
    }
  }, [lang, listening]);

  const toggle = useCallback(() => {
    if (isNative()) {
      void toggleNative();
      return;
    }
    const recognition = web.current;
    if (!recognition) return;
    if (listening) {
      recognition.stop();
      setListening(false);
    } else {
      try {
        recognition.start();
        setListening(true);
      } catch {
        setListening(false);
      }
    }
  }, [listening, toggleNative]);

  return { supported, listening, toggle };
}
