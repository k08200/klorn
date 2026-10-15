/**
 * Files tab and Teams free-time (productization plan P12) — the pure rules in
 * packages/web/src/app/files/model.ts, packages/web/src/app/today/free-time-model.ts
 * and packages/web/src/lib/home.ts: when the Files tab shows (FD-7), how the
 * drive list is asked for, which links a row may open, and when and how the
 * team availability is asked for.
 */

import { describe, expect, it } from "vitest";
import {
  FILES_PAGE_SIZE,
  filesListPath,
  formatFileSize,
  RECENT_FILES_LIMIT,
  safeWebUrl,
} from "../../../web/src/app/files/model";
import {
  availabilityPath,
  FREE_TIME_DURATION_MINUTES,
  FREE_TIME_WINDOW_DAYS,
  formatSlot,
  freeTimeVisible,
} from "../../../web/src/app/today/free-time-model";
import { FILES_HOME, filesEnabled, showFilesNav, withFiles } from "../../../web/src/lib/home";

describe("Files tab visibility (FD-7)", () => {
  it("shows in the unified nav only while the server reports a drive source", () => {
    expect(showFilesNav({ unifiedHome: true, files: true })).toBe(true);
    expect(showFilesNav({ unifiedHome: true, files: false })).toBe(false);
    expect(showFilesNav({ unifiedHome: true })).toBe(false);
    expect(showFilesNav({ unifiedHome: false, files: true })).toBe(false);
    expect(showFilesNav(null)).toBe(false);
    expect(showFilesNav(undefined)).toBe(false);
  });

  it("opens the page on the files flag alone, exactly true", () => {
    expect(FILES_HOME).toBe("/files");
    expect(filesEnabled({ files: true })).toBe(true);
    expect(filesEnabled({ files: false })).toBe(false);
    expect(filesEnabled({})).toBe(false);
    expect(filesEnabled(null)).toBe(false);
  });
});

describe("withFiles", () => {
  const nav = ["today", "mail", "calendar", "assistant"] as const;

  it("puts Files before Assistant when shown (Today · Mail · Calendar · Files · Assistant)", () => {
    expect(withFiles(nav, "files", true)).toEqual([
      "today",
      "mail",
      "calendar",
      "files",
      "assistant",
    ]);
  });

  it("leaves the nav as it was when hidden, as a new array", () => {
    const result = withFiles(nav, "files", false);
    expect(result).toEqual([...nav]);
    expect(result).not.toBe(nav);
  });
});

describe("filesListPath", () => {
  it("asks for the first page with the default size", () => {
    expect(filesListPath({})).toBe(`/api/drive/files?limit=${FILES_PAGE_SIZE}`);
  });

  it("carries a trimmed search and the cursor, URL-encoded", () => {
    const path = filesListPath({ q: "  Q3 plan & budget ", cursor: "abc/+=" });
    const url = new URL(path, "https://x.test");
    expect(url.pathname).toBe("/api/drive/files");
    expect(url.searchParams.get("q")).toBe("Q3 plan & budget");
    expect(url.searchParams.get("cursor")).toBe("abc/+=");
  });

  it("drops a blank search, so a blank box lists", () => {
    expect(new URL(filesListPath({ q: "   " }), "https://x.test").searchParams.has("q")).toBe(
      false,
    );
  });

  it("never sends more search text than the server reads", () => {
    const q = new URL(filesListPath({ q: "a".repeat(5000) }), "https://x.test").searchParams.get(
      "q",
    );
    expect(q).toHaveLength(100);
  });

  it("takes a smaller page for Today's recent files", () => {
    const url = new URL(filesListPath({ limit: RECENT_FILES_LIMIT }), "https://x.test");
    expect(url.searchParams.get("limit")).toBe(String(RECENT_FILES_LIMIT));
    expect(RECENT_FILES_LIMIT).toBeLessThanOrEqual(5);
  });
});

describe("formatFileSize", () => {
  it("says nothing for a folder or an unknown size", () => {
    expect(formatFileSize(null, "en")).toBe("");
    expect(formatFileSize(-1, "en")).toBe("");
    expect(formatFileSize(Number.NaN, "en")).toBe("");
  });

  it("picks a unit and keeps at most one decimal", () => {
    expect(formatFileSize(0, "en")).toBe("0 B");
    expect(formatFileSize(900, "en")).toBe("900 B");
    expect(formatFileSize(1536, "en")).toBe("1.5 KB");
    expect(formatFileSize(5 * 1024 * 1024, "en")).toBe("5 MB");
    expect(formatFileSize(3.25 * 1024 ** 3, "en")).toBe("3.3 GB");
  });
});

describe("safeWebUrl", () => {
  it("keeps an https link", () => {
    expect(safeWebUrl("https://drive.example.com/file/d/1")).toBe(
      "https://drive.example.com/file/d/1",
    );
  });

  it("refuses anything else: javascript:, data:, http:, relative, junk", () => {
    expect(safeWebUrl("javascript:alert(1)")).toBeNull();
    expect(safeWebUrl("data:text/html,<script>")).toBeNull();
    expect(safeWebUrl("http://drive.example.com/x")).toBeNull();
    expect(safeWebUrl("/api/drive/files/1")).toBeNull();
    expect(safeWebUrl("not a url")).toBeNull();
    expect(safeWebUrl(null)).toBeNull();
    expect(safeWebUrl("")).toBeNull();
  });
});

describe("Teams free-time", () => {
  it("shows only with team mode on and at least one saved team", () => {
    const team = { id: "t1", name: "AX", members: ["a@x.com"] };
    expect(freeTimeVisible({ teamMode: true }, [team])).toBe(true);
    expect(freeTimeVisible({ teamMode: true }, [])).toBe(false);
    expect(freeTimeVisible({ teamMode: false }, [team])).toBe(false);
    expect(freeTimeVisible({}, [team])).toBe(false);
    expect(freeTimeVisible(null, [team])).toBe(false);
  });

  it("asks for the next days from now, within the server's 14-day cap", () => {
    const now = new Date("2026-10-15T01:00:00.000Z");
    const url = new URL(availabilityPath("team/1", now), "https://x.test");
    expect(url.pathname).toBe("/api/teams/team%2F1/availability");
    const start = Date.parse(url.searchParams.get("window_start") ?? "");
    const end = Date.parse(url.searchParams.get("window_end") ?? "");
    expect(start).toBe(now.getTime());
    expect(end - start).toBe(FREE_TIME_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    expect(FREE_TIME_WINDOW_DAYS).toBeLessThanOrEqual(14);
    expect(url.searchParams.get("duration_minutes")).toBe(String(FREE_TIME_DURATION_MINUTES));
  });

  it("formats a slot in the given zone, start to end", () => {
    const label = formatSlot(
      { startTime: "2026-10-15T01:00:00.000Z", endTime: "2026-10-15T01:30:00.000Z" },
      "en-US",
      "Asia/Seoul",
    );
    expect(label).toContain("10:00");
    expect(label).toContain("10:30");
    expect(label).toContain("Oct");
  });

  it("returns an empty label for an unreadable slot rather than throwing", () => {
    expect(formatSlot({ startTime: "nope", endTime: "nope" }, "en-US", "Asia/Seoul")).toBe("");
    expect(
      formatSlot(
        { startTime: "2026-10-15T01:00:00.000Z", endTime: "2026-10-15T01:30:00.000Z" },
        "en-US",
        "Not/AZone",
      ),
    ).not.toBe("");
  });
});
