"use client";

/**
 * The day at a glance: date, a one-sentence verdict, how busy each hour is,
 * two or three stretches of the day, and the ranked things to attend to. All
 * of the text is written and localized by the server; this only draws it.
 */

import type { BriefingStructure } from "../../briefing/use-briefing";

const CURVE_WIDTH = 280;
const CURVE_HEIGHT = 36;
const CURVE_PAD = 3;

export function DayShape({ structure }: { structure: BriefingStructure }) {
  const peak = Math.max(...structure.curve, 1);
  const step = CURVE_WIDTH / Math.max(structure.curve.length - 1, 1);
  const points = structure.curve.map((count, index) => ({
    x: index * step,
    y: CURVE_HEIGHT - (count / peak) * (CURVE_HEIGHT - 2 * CURVE_PAD) - CURVE_PAD,
    busy: count > 0,
  }));
  const path = points.map((p, index) => `${index === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");

  return (
    <section className="rounded-card border border-line p-4 md:p-5">
      <p className="text-caption text-ink-muted">{structure.dateLabel}</p>
      <h2 className="mt-1 text-title text-ink [word-break:keep-all]">{structure.headline}</h2>
      {points.some((p) => p.busy) && (
        <svg
          viewBox={`0 0 ${CURVE_WIDTH} ${CURVE_HEIGHT}`}
          preserveAspectRatio="none"
          className="mt-3 h-9 w-full text-line-strong"
          aria-hidden="true"
        >
          <path
            d={path}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
          {/* Zero-length round-capped strokes: dots that stay round however the
              curve is stretched to the card's width. */}
          {points
            .filter((p) => p.busy)
            .map((p) => (
              <path
                key={p.x}
                d={`M${p.x},${p.y}h0`}
                fill="none"
                strokeWidth="6"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                className="stroke-accent-solid"
              />
            ))}
        </svg>
      )}
      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3 md:gap-4">
        {structure.segments.map((segment) => (
          <div
            key={segment.label}
            className="md:border-l md:border-line-soft md:pl-4 md:first:border-l-0 md:first:pl-0"
          >
            <p
              className={`text-caption font-medium ${segment.kind === "busy" ? "text-accent-deep" : "text-ink-muted"}`}
            >
              {segment.label}
            </p>
            <p className="mt-0.5 text-body text-ink [word-break:keep-all]">{segment.summary}</p>
          </div>
        ))}
      </div>
      {structure.attention.length > 0 && (
        <ol className="mt-4 flex flex-col gap-1 border-t border-line-soft pt-3">
          {structure.attention.map((item) => (
            <li key={item.rank} className="flex gap-2 text-body text-ink">
              <span className="w-4 shrink-0 tabular-nums text-ink-muted">{item.rank}</span>
              <span className="min-w-0 [word-break:keep-all]">
                {item.action}
                {item.reason ? <span className="text-ink-muted"> — {item.reason}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
