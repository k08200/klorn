#!/usr/bin/env python3
"""Build the captioned demo (en/ko), screen-cut promo (en/ko), and the landing
webm+poster from the latest recording — using the SCENE timestamps the recorder
logged, so caption windows always match the take.

Inputs:  videos/*.webm (latest), scenes.txt (SCENE <name> <sec> lines), assets/
Outputs: out/klorn-demo-{en,ko}.mp4, out/klorn-promo-{en,ko}.mp4,
         out/klorn-demo.webm, out/klorn-demo-poster.jpg
"""

import glob
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)

ENC = ["-c:v", "libx264", "-crf", "20", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an"]
POS = "(W-w)/2:H-h-36"
ORDER = ["login", "firewall", "mail_list", "judgment", "draft", "send", "calendar", "new_event", "settings", "end"]


def run(args):
    subprocess.run(args, check=True)


def latest_video():
    vids = sorted(glob.glob(os.path.join(HERE, "videos", "*.webm")), key=os.path.getmtime)
    if not vids:
        raise SystemExit("no videos/*.webm — run record-demo.mjs first")
    return vids[-1]


def load_scenes():
    scenes = {}
    with open(os.path.join(HERE, "scenes.txt")) as f:
        for line in f:
            parts = line.split()
            if len(parts) == 3 and parts[0] == "SCENE":
                scenes[parts[1]] = float(parts[2])
    missing = [n for n in ORDER if n not in scenes]
    if missing:
        raise SystemExit(f"scenes.txt missing: {missing}")
    return scenes


def build_demo(video, scenes, lang):
    # каждый caption: scene start+0.15 → next scene start-0.15 (settings → end-1.2)
    windows = []
    for i, name in enumerate(ORDER[:-1]):  # skip 'end'
        start = scenes[name] + 0.15
        stop = scenes[ORDER[i + 1]] - 0.15
        if name == "settings":
            stop = scenes["end"] - 1.2
        windows.append((name, start, stop))
    inputs = ["-i", video]
    for name, _, _ in windows:
        inputs += ["-i", os.path.join(ASSETS, f"s_{lang}_{name}.png")]
    chain = "[0:v]fps=30[v0];"
    for i, (_, a, b) in enumerate(windows):
        chain += f"[v{i}][{i + 1}:v]overlay={POS}:enable='between(t,{a:.2f},{b:.2f})'[v{i + 1}];"
    chain = chain.rstrip(";")
    trim = scenes["end"] + 0.8
    out = os.path.join(OUT, f"klorn-demo-{lang}.mp4")
    run(["ffmpeg", "-y", "-v", "error", "-to", f"{trim:.2f}", *inputs,
         "-filter_complex", chain, "-map", f"[v{len(windows)}]", *ENC, out])
    print("built", out)
    return out


def seg(video, a, b, png, out):
    run(["ffmpeg", "-y", "-v", "error", "-ss", f"{a:.2f}", "-to", f"{b:.2f}", "-i", video,
         "-i", png, "-filter_complex", f"[0:v]fps=30[b];[b][1:v]overlay={POS}[o]",
         "-map", "[o]", *ENC, out])


def card_clip(png, dur, out):
    run(["ffmpeg", "-y", "-v", "error", "-loop", "1", "-t", f"{dur}", "-i", png,
         "-vf", "fps=30", *ENC, out])


def build_promo(video, scenes, lang):
    a = os.path.join(ASSETS, "")
    cuts = [
        (scenes["firewall"] + 1.2, scenes["firewall"] + 7.2, f"{a}s_p{lang}_p1.png"),
        (scenes["judgment"] + 1.3, scenes["judgment"] + 6.8, f"{a}s_p{lang}_p2.png"),
        (scenes["send"] - 4.0, scenes["send"] - 0.1, f"{a}s_p{lang}_p3.png"),
        (scenes["new_event"] + 0.5, scenes["new_event"] + 5.8, f"{a}s_p{lang}_p4.png"),
    ]
    tmp = []
    card_clip(f"{a}c_title_{lang}.png", 3.0, os.path.join(OUT, f"_t_{lang}.mp4"))
    tmp.append(f"_t_{lang}.mp4")
    for i, (s, e, png) in enumerate(cuts):
        name = f"_s{i}_{lang}.mp4"
        seg(video, s, e, png, os.path.join(OUT, name))
        tmp.append(name)
    card_clip(f"{a}c_end_{lang}.png", 3.5, os.path.join(OUT, f"_e_{lang}.mp4"))
    tmp.append(f"_e_{lang}.mp4")
    lst = os.path.join(OUT, f"_pl_{lang}.txt")
    with open(lst, "w") as f:
        f.writelines(f"file '{n}'\n" for n in tmp)
    out = os.path.join(OUT, f"klorn-promo-{lang}.mp4")
    run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", out])
    for n in tmp:
        os.remove(os.path.join(OUT, n))
    os.remove(lst)
    print("built", out)


def build_landing(demo_en, scenes):
    webm = os.path.join(OUT, "klorn-demo.webm")
    run(["ffmpeg", "-y", "-v", "error", "-i", demo_en, "-c:v", "libvpx-vp9", "-crf", "34",
         "-b:v", "0", "-deadline", "good", "-cpu-used", "4", "-row-mt", "1", "-an", webm])
    poster = os.path.join(OUT, "klorn-demo-poster.jpg")
    t = scenes["firewall"] + 2.5
    run(["ffmpeg", "-y", "-v", "error", "-ss", f"{t:.2f}", "-i", demo_en,
         "-frames:v", "1", "-q:v", "3", poster])
    print("built", webm, "and", poster)


if __name__ == "__main__":
    video = latest_video()
    scenes = load_scenes()
    demo_en = build_demo(video, scenes, "en")
    build_demo(video, scenes, "ko")
    build_promo(video, scenes, "en")
    build_promo(video, scenes, "ko")
    build_landing(demo_en, scenes)
    print("ALL DONE →", OUT)
