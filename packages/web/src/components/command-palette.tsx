"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api";

interface Command {
  id: string;
  label: string;
  sublabel?: string;
  action: () => void;
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const commands: Command[] = [
    {
      id: "approval-queue",
      label: "결정함 열기",
      sublabel: "승인 대기 중인 결정을 확인",
      action: () => router.push("/inbox"),
    },
    {
      id: "chat",
      label: "스레드 열기",
      sublabel: "현재 업무 맥락 이어가기",
      action: () => router.push("/chat"),
    },
    {
      id: "new-chat",
      label: "새 결정 스레드",
      sublabel: "새 업무 맥락에서 시작",
      action: () => {
        apiFetch<{ id: string }>("/api/chat/conversations", {
          method: "POST",
        })
          .then((conv) => router.push(`/chat/${conv.id}`))
          .catch(() => router.push("/chat"));
      },
    },
    {
      id: "briefing",
      label: "오늘 브리핑 열기",
      sublabel: "오늘의 신호 요약 확인",
      action: () => router.push("/briefing"),
    },
    {
      id: "settings",
      label: "설정 열기",
      sublabel: "연동, 신뢰, 메모리 관리",
      action: () => router.push("/settings"),
    },
    {
      id: "billing",
      label: "플랜 및 사용량 열기",
      sublabel: "한도와 결제 상태 확인",
      action: () => router.push("/billing"),
    },
    {
      id: "shortcuts",
      label: "키보드 단축키",
      sublabel: "단축키 목록 보기 (Cmd+/)",
      action: () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", metaKey: true }));
      },
    },
  ];

  const filtered = commands.filter((c) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return c.label.toLowerCase().includes(q) || (c.sublabel || "").toLowerCase().includes(q);
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
        setQuery("");
        setSelected(0);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((prev) => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && filtered[selected]) {
      e.preventDefault();
      filtered[selected].action();
      setOpen(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[20vh]">
      <button
        type="button"
        className="absolute inset-0 bg-black/60"
        aria-label="명령 팔레트 닫기"
        onClick={() => setOpen(false)}
      />
      <div className="relative w-full max-w-md rounded-xl border border-stone-700 bg-stone-900 shadow-2xl">
        <div className="p-3 border-b border-stone-800">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="결정, 화면, 설정 검색..."
            className="w-full bg-transparent text-sm focus:outline-none placeholder-stone-500"
          />
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="text-sm text-stone-500 px-4 py-3">일치하는 명령이 없어요.</p>
          ) : (
            filtered.map((cmd, i) => (
              <button
                type="button"
                key={cmd.id}
                onClick={() => {
                  cmd.action();
                  setOpen(false);
                }}
                onMouseEnter={() => setSelected(i)}
                className={`w-full text-left px-4 py-2.5 flex items-center justify-between text-sm transition ${
                  i === selected
                    ? "bg-stone-800 text-white"
                    : "text-stone-400 hover:bg-stone-800/50"
                }`}
              >
                <span>{cmd.label}</span>
                {cmd.sublabel && <span className="text-xs text-stone-600">{cmd.sublabel}</span>}
              </button>
            ))
          )}
        </div>
        <div className="border-t border-stone-800 px-4 py-2 flex items-center justify-between text-[10px] text-stone-600">
          <span>화살표로 이동, Enter로 열기</span>
          <span>Esc로 닫기</span>
        </div>
      </div>
    </div>
  );
}
