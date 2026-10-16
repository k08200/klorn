/**
 * The Google Picker (step D5c of docs/providers/unified-platform-plan.md): the
 * person picks files of a linked Google account, and only their ids come back.
 *
 * Compiled in only when the web is built with NEXT_PUBLIC_GOOGLE_DRIVE_PICKER=on:
 * app/files/google-drive-connect.tsx imports this module dynamically behind that
 * switch, and next.config.ts lets the CSP load Google's script and frame only
 * then. The loader script (https://apis.google.com/js/api.js) is added to the
 * page on the first click, never before.
 *
 * The session (POST /api/drive/google/accounts/:id/picker-session) carries a
 * drive.file access token: the one token Klorn hands the browser, because the
 * Picker runs here. It lives in this call only: never stored, never logged.
 */

export const GOOGLE_PICKER_SCRIPT_SRC = "https://apis.google.com/js/api.js";
/** The most files one pick returns; the server accepts no more (GOOGLE_PICK_MAX_IDS). */
export const GOOGLE_PICKER_MAX_ITEMS = 50;

/** What picker-session answers (`GoogleDrivePickerSessionResponse`). */
export interface GooglePickerSession {
  readonly accessToken: string;
  readonly developerKey: string;
  readonly appId: string;
}

// The slice of Google's Picker API used here (it ships no types this repo has).
interface PickerDoc {
  readonly id?: unknown;
}
interface PickerResult {
  readonly action?: unknown;
  readonly docs?: readonly PickerDoc[];
}
interface DocsView {
  setIncludeFolders(include: boolean): DocsView;
  setSelectFolderEnabled(enabled: boolean): DocsView;
}
interface Picker {
  setVisible(visible: boolean): void;
  dispose(): void;
}
interface PickerBuilder {
  addView(view: DocsView): PickerBuilder;
  enableFeature(feature: string): PickerBuilder;
  setMaxItems(max: number): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(appId: string): PickerBuilder;
  setLocale(locale: string): PickerBuilder;
  setCallback(callback: (result: PickerResult) => void): PickerBuilder;
  build(): Picker;
}
interface PickerNamespace {
  readonly Action: { readonly PICKED: string; readonly CANCEL: string };
  readonly Feature: { readonly MULTISELECT_ENABLED: string };
  readonly ViewId: { readonly DOCS: string };
  readonly DocsView: new (viewId: string) => DocsView;
  readonly PickerBuilder: new () => PickerBuilder;
}
interface GapiLoader {
  load(
    api: "picker",
    options: {
      callback: () => void;
      onerror: () => void;
      timeout: number;
      ontimeout: () => void;
    },
  ): void;
}
type PickerWindow = Window & {
  gapi?: GapiLoader;
  google?: { picker?: PickerNamespace };
};

/** Google's locale code for each of Klorn's; Google names Chinese by region. */
const PICKER_LOCALES: Readonly<Record<string, string>> = {
  en: "en",
  ko: "ko",
  ja: "ja",
  zh: "zh-CN",
  es: "es",
  fr: "fr",
  de: "de",
};

/** How long Google's loader may take to bring the Picker before the click fails. */
const PICKER_LOAD_TIMEOUT_MS = 15_000;

let pickerLoad: Promise<PickerNamespace> | null = null;

function addLoaderScript(): Promise<GapiLoader> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GOOGLE_PICKER_SCRIPT_SRC;
    script.async = true;
    script.onload = () => {
      const gapi = (window as PickerWindow).gapi;
      if (gapi) resolve(gapi);
      else reject(new Error("Google's loader did not start"));
    };
    script.onerror = () => {
      // Out of the page, so a retry adds one script, not a second.
      script.remove();
      reject(new Error("Google's loader could not be fetched"));
    };
    document.head.appendChild(script);
  });
}

/** Google's loader and the Picker, fetched once, on the first call. A failure lets the next call retry. */
function loadPicker(): Promise<PickerNamespace> {
  pickerLoad ??= addLoaderScript()
    .then(
      (gapi) =>
        new Promise<PickerNamespace>((resolve, reject) => {
          gapi.load("picker", {
            callback: () => {
              const picker = (window as PickerWindow).google?.picker;
              if (picker) resolve(picker);
              else reject(new Error("The Google Picker did not load"));
            },
            onerror: () => reject(new Error("The Google Picker did not load")),
            timeout: PICKER_LOAD_TIMEOUT_MS,
            ontimeout: () => reject(new Error("The Google Picker took too long to load")),
          });
        }),
    )
    .catch((err: unknown) => {
      pickerLoad = null;
      throw err;
    });
  return pickerLoad;
}

const pickedIds = (result: PickerResult): string[] =>
  (result.docs ?? [])
    .map((doc) => doc.id)
    .filter((id): id is string => typeof id === "string" && id !== "")
    .slice(0, GOOGLE_PICKER_MAX_ITEMS);

/**
 * Open the Picker for one account's session: the picked file ids, or null when
 * the person closed it. Folders show for browsing but cannot be picked.
 */
export async function pickGoogleDriveFiles(
  session: GooglePickerSession,
  locale: string,
): Promise<string[] | null> {
  const picker = await loadPicker();
  return await new Promise<string[] | null>((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false);
    const opened = new picker.PickerBuilder()
      .addView(view)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setMaxItems(GOOGLE_PICKER_MAX_ITEMS)
      .setOAuthToken(session.accessToken)
      .setDeveloperKey(session.developerKey)
      .setAppId(session.appId)
      .setLocale(PICKER_LOCALES[locale] ?? "en")
      .setCallback((result) => {
        if (result.action === picker.Action.PICKED) {
          opened.dispose();
          resolve(pickedIds(result));
        } else if (result.action === picker.Action.CANCEL) {
          opened.dispose();
          resolve(null);
        }
      })
      .build();
    opened.setVisible(true);
  });
}
