import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

const BG = "#0f1115";
const AMBER = "#fcd34d";
const WHITE = "#f5f5f4";
const GREY = "#a8a29e";
const FPS = 30;

type Lang = "en" | "ko";
const T = (lang: Lang) => ({
  loud1: lang === "ko" ? "받은편지함이" : "Your inbox",
  loud2: lang === "ko" ? "너무 시끄럽다." : "is loud.",
  sorts: lang === "ko" ? "Klorn이 모든 메일을 분류합니다" : "Klorn sorts every email",
  cap1: lang === "ko" ? "실제 Gmail 위에서 작동하는 어텐션 방화벽" : "The attention firewall — live on your Gmail",
  cap2: lang === "ko" ? "모든 메일에 AI 판정 — 요약 · 핵심 · 액션" : "AI judgment on every message — summary · key points · actions",
  cap3: lang === "ko" ? "답장은 AI가 초안, 승인은 당신이" : "Drafts replies. You approve.",
  cap4: lang === "ko" ? "메일에서 캘린더·미팅까지, 클릭 한 번" : "Calendar + meetings — one click from your mail",
  tag: lang === "ko" ? "중요한 것만 당신을 부릅니다." : "Only what matters interrupts you.",
  cta: "app.klorn.ai",
});

const FONT = (lang: Lang) =>
  lang === "ko"
    ? "'Apple SD Gothic Neo', 'Helvetica Neue', sans-serif"
    : "'Helvetica Neue', Helvetica, sans-serif";

const SUBJECTS = [
  "Re: Q3 budget review", "🎉 50% off this week only", "Your invoice is ready",
  "Meeting moved to 5pm?", "Weekly digest #142", "Security alert",
  "Series A intro call?", "Standup notes", "Newsletter: July picks",
  "Payment reminder", "New login detected", "Lunch tomorrow?",
];

// ── Scene 1: noisy inbox → pulled into the firewall ──
const Noise: React.FC<{ lang: Lang }> = ({ lang }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const t = T(lang);
  return (
    <AbsoluteFill style={{ background: BG, overflow: "hidden" }}>
      {SUBJECTS.map((s, i) => {
        const seed = (i * 37) % 12;
        const delay = i * 3;
        const fly = spring({ frame: frame - delay, fps: FPS, config: { damping: 14, mass: 0.9 } });
        const gone = interpolate(frame, [78, 100], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const x0 = (seed % 4) * (width / 4) + 60 + (i % 3) * 40;
        const y0 = Math.floor(seed / 4) * (height / 3.2) + 90 + (i % 5) * 26;
        const cx = width / 2 - 140;
        const cy = height / 2 - 26;
        const x = interpolate(gone, [0, 1], [x0, cx]);
        const y = interpolate(gone, [0, 1], [y0, cy]);
        const rot = interpolate(fly, [0, 1], [seed % 2 ? 14 : -14, seed % 2 ? -3 : 3]);
        return (
          <div
            key={s}
            style={{
              position: "absolute",
              left: x,
              top: y,
              transform: `translateY(${interpolate(fly, [0, 1], [80, 0])}px) rotate(${rot}deg) scale(${interpolate(gone, [0, 1], [1, 0.1])})`,
              opacity: fly * (1 - gone * 0.9),
              background: "rgba(28,25,23,0.92)",
              border: "1px solid rgba(255,255,255,0.14)",
              borderRadius: 12,
              padding: "14px 22px",
              color: "#d6d3d1",
              fontSize: 26,
              fontFamily: FONT("en"),
              whiteSpace: "nowrap",
              boxShadow: "0 12px 30px rgba(0,0,0,.45)",
            }}
          >
            {s}
          </div>
        );
      })}
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div
          style={{
            textAlign: "center",
            fontFamily: FONT(lang),
            opacity: interpolate(frame, [88, 104], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            transform: `scale(${spring({ frame: frame - 88, fps: FPS, config: { damping: 12 } }) * 0.2 + 0.8})`,
          }}
        >
          <div style={{ fontSize: 92, fontWeight: 800, color: WHITE, lineHeight: 1.1 }}>
            {t.loud1}
            <br />
            {t.loud2}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ── Scene 2: 4 tier badges spring in ──
const TIERS = [
  { name: "PUSH", n: 30, color: "#fb7185", desc: { en: "worth interrupting", ko: "지금 알릴 것" } },
  { name: "QUEUE", n: 84, color: "#fcd34d", desc: { en: "when you choose", ko: "볼 때 보는 것" } },
  { name: "SILENT", n: 83, color: "#78716c", desc: { en: "recorded, muted", ko: "조용히 기록" } },
  { name: "AUTO", n: 3, color: "#4ade80", desc: { en: "handled for you", ko: "알아서 처리" } },
];
const Tiers: React.FC<{ lang: Lang }> = ({ lang }) => {
  const frame = useCurrentFrame();
  const t = T(lang);
  return (
    <AbsoluteFill style={{ background: BG, alignItems: "center", justifyContent: "center", fontFamily: FONT(lang) }}>
      <div
        style={{
          fontSize: 56,
          fontWeight: 700,
          color: WHITE,
          marginBottom: 70,
          opacity: interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" }),
        }}
      >
        {t.sorts}
      </div>
      <div style={{ display: "flex", gap: 42 }}>
        {TIERS.map((tier, i) => {
          const s = spring({ frame: frame - 10 - i * 9, fps: FPS, config: { damping: 11, mass: 0.8 } });
          const count = Math.round(interpolate(Math.min(frame - 10 - i * 9, 45), [0, 45], [0, tier.n], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
          return (
            <div
              key={tier.name}
              style={{
                transform: `translateY(${(1 - s) * 120}px) scale(${0.6 + s * 0.4})`,
                opacity: s,
                width: 300,
                borderRadius: 22,
                border: `1.5px solid ${tier.color}55`,
                background: `linear-gradient(180deg, ${tier.color}14, transparent)`,
                boxShadow: `0 0 60px ${tier.color}22`,
                padding: "38px 34px",
                textAlign: "center",
              }}
            >
              <div style={{ color: tier.color, fontSize: 34, fontWeight: 800, letterSpacing: 2 }}>{tier.name}</div>
              <div style={{ color: WHITE, fontSize: 84, fontWeight: 800, margin: "10px 0 6px" }}>{count}</div>
              <div style={{ color: GREY, fontSize: 24 }}>{tier.desc[lang]}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// ── Product shot with Ken Burns + caption ──
const Shot: React.FC<{ src: string; caption: string; lang: Lang; zoomFrom?: number; zoomTo?: number; originY?: string }> = ({
  src, caption, lang, zoomFrom = 1.02, zoomTo = 1.12, originY = "40%",
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const z = interpolate(frame, [0, durationInFrames], [zoomFrom, zoomTo]);
  const inOp = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: "clamp" });
  const capS = spring({ frame: frame - 8, fps: FPS, config: { damping: 13 } });
  return (
    <AbsoluteFill style={{ background: BG, alignItems: "center", justifyContent: "center" }}>
      <div
        style={{
          width: "86%",
          borderRadius: 18,
          overflow: "hidden",
          border: "1px solid rgba(255,255,255,0.12)",
          boxShadow: "0 40px 120px rgba(0,0,0,.6)",
          opacity: inOp,
        }}
      >
        <Img src={staticFile(src)} style={{ width: "100%", display: "block", transform: `scale(${z})`, transformOrigin: `50% ${originY}` }} />
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 64,
          transform: `translateY(${(1 - capS) * 40}px)`,
          opacity: capS,
          background: "rgba(10,10,10,0.82)",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 16,
          padding: "18px 34px",
          color: WHITE,
          fontSize: 34,
          fontWeight: 700,
          fontFamily: FONT(lang),
        }}
      >
        {caption}
      </div>
    </AbsoluteFill>
  );
};

// ── Outro ──
const Outro: React.FC<{ lang: Lang }> = ({ lang }) => {
  const frame = useCurrentFrame();
  const t = T(lang);
  const s = spring({ frame, fps: FPS, config: { damping: 12 } });
  const line = interpolate(frame, [16, 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: BG, alignItems: "center", justifyContent: "center", fontFamily: FONT(lang) }}>
      <div style={{ transform: `scale(${0.7 + s * 0.3})`, opacity: s, textAlign: "center" }}>
        <div style={{ fontSize: 150, fontWeight: 800, color: WHITE, letterSpacing: -2 }}>Klorn</div>
        <div style={{ height: 5, width: `${line * 420}px`, background: AMBER, margin: "18px auto 26px", borderRadius: 3 }} />
        <div style={{ fontSize: 44, color: WHITE, fontWeight: 600 }}>{t.tag}</div>
        <div style={{ fontSize: 36, color: AMBER, marginTop: 22, fontWeight: 700 }}>{t.cta}</div>
      </div>
    </AbsoluteFill>
  );
};

// ── Timeline ──
const SEC = (s: number) => Math.round(s * FPS);
export const PROMO_DURATION = SEC(33);

export const Promo: React.FC<{ lang: Lang }> = ({ lang }) => {
  const t = T(lang);
  return (
    <AbsoluteFill style={{ background: BG }}>
      <Sequence from={0} durationInFrames={SEC(4.6)}>
        <Noise lang={lang} />
      </Sequence>
      <Sequence from={SEC(4.6)} durationInFrames={SEC(5.6)}>
        <Tiers lang={lang} />
      </Sequence>
      <Sequence from={SEC(10.2)} durationInFrames={SEC(5.4)}>
        <Shot src="shot-firewall.png" caption={t.cap1} lang={lang} originY="30%" />
      </Sequence>
      <Sequence from={SEC(15.6)} durationInFrames={SEC(5.0)}>
        <Shot src="shot-judgment.png" caption={t.cap2} lang={lang} originY="70%" zoomFrom={1.06} zoomTo={1.18} />
      </Sequence>
      <Sequence from={SEC(20.6)} durationInFrames={SEC(4.6)}>
        <Shot src="shot-draft.png" caption={t.cap3} lang={lang} originY="55%" />
      </Sequence>
      <Sequence from={SEC(25.2)} durationInFrames={SEC(4.2)}>
        <Shot src="shot-event.png" caption={t.cap4} lang={lang} originY="45%" zoomFrom={1.04} zoomTo={1.14} />
      </Sequence>
      <Sequence from={SEC(29.4)} durationInFrames={SEC(3.6)}>
        <Outro lang={lang} />
      </Sequence>
    </AbsoluteFill>
  );
};
