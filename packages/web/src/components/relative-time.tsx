"use client";

import { useEffect, useState } from "react";

function getRelativeTime(date: string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diff = now - then;

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "Just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  if (days < 30) return `${Math.floor(days / 7)}w ago`;

  return new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function RelativeTime({ date, className }: { date: string; className?: string }) {
  const [text, setText] = useState(() => getRelativeTime(date));

  useEffect(() => {
    setText(getRelativeTime(date));
    const interval = setInterval(() => setText(getRelativeTime(date)), 60_000);
    return () => clearInterval(interval);
  }, [date]);

  return (
    <time dateTime={date} title={new Date(date).toLocaleString("en-US")} className={className}>
      {text}
    </time>
  );
}
