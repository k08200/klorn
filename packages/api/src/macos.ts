/**
 * macOS Native Integrations
 *
 * Clipboard, Finder, system info, screen text, app control via AppleScript.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const IS_MACOS = process.platform === "darwin";

async function runAppleScript(script: string): Promise<string> {
  if (!IS_MACOS) throw new Error("macOS integration requires macOS");
  const { stdout } = await exec("osascript", ["-e", script], { timeout: 10_000 });
  return stdout.trim();
}

/** Escape string for safe embedding in AppleScript double-quoted strings */
function escapeAppleScript(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

/** Get clipboard contents */
export async function getClipboard(): Promise<{ text: string }> {
  const { stdout } = await exec("pbpaste", [], { timeout: 3_000 });
  return { text: stdout };
}

/** Set clipboard contents */
export async function setClipboard(text: string): Promise<{ success: boolean }> {
  const { execFile: ef } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const proc = ef("pbcopy", [], { timeout: 3_000 }, (err) => {
      if (err) reject(err);
      else resolve({ success: true });
    });
    proc.stdin?.write(text);
    proc.stdin?.end();
  });
}

/** Get frontmost application name */
export async function getFrontmostApp(): Promise<{ name: string; bundleId: string }> {
  const name = await runAppleScript(
    'tell application "System Events" to get name of first application process whose frontmost is true',
  );
  const bundleId = await runAppleScript(
    'tell application "System Events" to get bundle identifier of first application process whose frontmost is true',
  );
  return { name, bundleId };
}

/** Get list of running applications */
export async function getRunningApps(): Promise<{ apps: string[] }> {
  const result = await runAppleScript(
    'tell application "System Events" to get name of every application process whose background only is false',
  );
  return { apps: result.split(", ") };
}

/** Open a URL or file — restricted to safe paths and URLs */
export async function openItem(itemPath: string): Promise<{ success: boolean; error?: string }> {
  // Allow http(s) URLs only
  if (/^https?:\/\//i.test(itemPath)) {
    // Validate URL is well-formed
    let parsed: URL;
    try {
      parsed = new URL(itemPath);
    } catch {
      return { success: false, error: "Invalid URL" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { success: false, error: "Only HTTP(S) URLs are allowed" };
    }
    await exec("open", [parsed.href], { timeout: 5_000 });
    return { success: true };
  }

  // For file paths: resolve to absolute and validate strictly
  const { resolve } = await import("node:path");
  const resolved = resolve(itemPath);

  // Block system/sensitive directories
  const blocked = ["/etc", "/var", "/private", "/System", "/usr", "/bin", "/sbin", "/Library"];
  if (blocked.some((prefix) => resolved.startsWith(prefix))) {
    return { success: false, error: "Access to system directories is not allowed" };
  }
  // Block dotfiles and hidden directories
  if (/\/\./.test(resolved)) {
    return { success: false, error: "Access to hidden files/directories is not allowed" };
  }
  // Must be under user home directory
  const homeDir = process.env.HOME || "/Users";
  if (!resolved.startsWith(homeDir)) {
    return { success: false, error: "Can only open files under home directory" };
  }

  await exec("open", [resolved], { timeout: 5_000 });
  return { success: true };
}

/** Get selected files in Finder */
export async function getFinderSelection(): Promise<{ files: string[] }> {
  try {
    const result = await runAppleScript(
      'tell application "Finder" to get POSIX path of (selection as alias list)',
    );
    return { files: result ? result.split(", ") : [] };
  } catch {
    return { files: [] };
  }
}

/** Get system info (battery, disk, etc.) */
export async function getSystemInfo(): Promise<{
  battery: string;
  volume: string;
  brightness: string;
  wifi: string;
}> {
  const [battery, volume, wifi] = await Promise.all([
    exec("pmset", ["-g", "batt"], { timeout: 3_000 })
      .then(({ stdout }) => {
        const match = stdout.match(/(\d+)%/);
        return match ? `${match[1]}%` : "unknown";
      })
      .catch(() => "unknown"),
    runAppleScript("output volume of (get volume settings)").catch(() => "unknown"),
    exec("networksetup", ["-getairportnetwork", "en0"], { timeout: 3_000 })
      .then(({ stdout }) => stdout.replace("Current Wi-Fi Network: ", "").trim())
      .catch(() => "unknown"),
  ]);

  return { battery, volume, brightness: "unknown", wifi };
}

/** Type text using keyboard simulation */
export async function typeText(text: string): Promise<{ success: boolean }> {
  const escaped = escapeAppleScript(text);
  await runAppleScript(`tell application "System Events" to keystroke "${escaped}"`);
  return { success: true };
}

/** Take a screenshot and return the file path */
export async function takeScreenshot(): Promise<{ path: string }> {
  const path = `/tmp/klorn-screenshot-${Date.now()}.png`;
  await exec("screencapture", ["-x", path], { timeout: 5_000 });
  return { path };
}

/** Get macOS availability */
export function isMacOS(): boolean {
  return IS_MACOS;
}

// Tool definitions for function calling
export const MACOS_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "get_clipboard",
      description:
        "Read the current macOS clipboard contents. Use when user says 'paste this' or 'what did I copy'.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_clipboard",
      description: "Copy text to the macOS clipboard. Use when user wants to copy something.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to copy to clipboard" },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_running_apps",
      description:
        "List all currently running applications on the Mac. Use to check what the user is working on.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "open_item",
      description:
        "Open a URL in the default browser or a file/app on macOS. Use when user wants to open something.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "URL (https://...) or file path to open",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_system_info",
      description:
        "Get Mac system info: battery level, volume, Wi-Fi network. Use when user asks about their computer status.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "take_screenshot",
      description:
        "Take a screenshot of the current screen. Returns the file path of the saved screenshot.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];
