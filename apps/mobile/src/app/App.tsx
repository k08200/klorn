import type { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { lazy, Suspense, useEffect } from "react";
import { persistOptions } from "../api/query-client";
import { SessionProvider, useSession } from "../auth/session";
import type { Locale } from "../i18n";
import { I18nProvider } from "../i18n/I18nProvider";
import { Shell } from "../layout/Shell";
import { useLayoutPlan } from "../layout/viewport";
import { installBackButton } from "../platform/back-button";
import { installKeyboardInsets } from "../platform/keyboard";
import { isNative } from "../platform/native";
import { PushLayer } from "../push/PushLayer";
import { RouterProvider, useRouter } from "../router/Router";
import type { Route } from "../router/routes";
import { LinkRelay } from "../screens/accounts/LinkRelay";
import { CoverScreen } from "../screens/cover/CoverScreen";
import { WelcomeScreen } from "../screens/login/WelcomeScreen";
import { TodayScreen } from "../screens/today/TodayScreen";
import { ReadySignal } from "../ui/ReadySignal";
import { StatusNoteHost } from "../ui/StatusNote";
import { ThemeProvider } from "./theme";

// Today, Welcome and the Flip cover are first screens and ship in the main
// chunk. Every other screen is its own chunk, loaded from the bundle on first
// use (Mail is the largest: reader, composer, sheets, sanitizer), so a cold
// start parses less. Each chunk carries its own stylesheet; anything two
// screens share lives in styles/shared.css.
const MailScreen = lazy(() =>
  import("../screens/mail/MailScreen").then((m) => ({ default: m.MailScreen })),
);
const CalendarScreen = lazy(() =>
  import("../screens/calendar/CalendarScreen").then((m) => ({ default: m.CalendarScreen })),
);
const FilesScreen = lazy(() =>
  import("../screens/files/FilesScreen").then((m) => ({ default: m.FilesScreen })),
);
const AssistantScreen = lazy(() =>
  import("../screens/assistant/AssistantScreen").then((m) => ({ default: m.AssistantScreen })),
);
const AccountsScreen = lazy(() =>
  import("../screens/accounts/AccountsScreen").then((m) => ({ default: m.AccountsScreen })),
);
const SettingsScreen = lazy(() =>
  import("../screens/settings/SettingsScreen").then((m) => ({ default: m.SettingsScreen })),
);

function ScreenFor({ route }: { route: Route }) {
  switch (route.name) {
    case "today":
    case "notFound":
      return <TodayScreen />;
    case "mail":
      return <MailScreen lane={route.lane} id={route.id} view={route.view} />;
    case "calendar":
      return <CalendarScreen id={route.id} />;
    case "files":
      return <FilesScreen id={route.id} />;
    case "assistant":
      return <AssistantScreen section={route.section} id={route.id} />;
    case "accounts":
      return <AccountsScreen />;
    case "settings":
      return <SettingsScreen section={route.section} />;
  }
}

function Screen({ route }: { route: Route }) {
  return (
    <Suspense fallback={<div className="boot" aria-busy="true" />}>
      <ScreenFor route={route} />
    </Suspense>
  );
}

let splashHidden = false;

function hideSplash() {
  if (splashHidden || !isNative()) return;
  splashHidden = true;
  void import("@capacitor/splash-screen").then(({ SplashScreen }) =>
    SplashScreen.hide({ fadeOutDuration: 160 }).catch(() => {}),
  );
}

function Root() {
  const session = useSession();
  const plan = useLayoutPlan();
  const router = useRouter();

  useEffect(() => installBackButton(router.back), [router.back]);
  useEffect(() => installKeyboardInsets(), []);
  useEffect(() => {
    if (session.status !== "loading") hideSplash();
  }, [session.status]);

  if (session.status === "loading") return <div className="boot" aria-busy="true" />;
  if (session.status === "signedOut") {
    return (
      <>
        <WelcomeScreen />
        <ReadySignal />
      </>
    );
  }
  const signedIn = (
    <>
      <ReadySignal />
      <StatusNoteHost />
      <LinkRelay />
      <PushLayer />
    </>
  );
  if (plan.sizeClass === "cover" && plan.posture === "flat") {
    return (
      <>
        <CoverScreen />
        {signedIn}
      </>
    );
  }
  return (
    <>
      <Shell plan={plan}>
        <Screen route={router.route} />
      </Shell>
      {signedIn}
    </>
  );
}

export function App({
  queryClient,
  initialLocale = null,
}: {
  queryClient: QueryClient;
  /** The stored language override, read before the first render (main.tsx). */
  initialLocale?: Locale | null;
}) {
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions("session")}>
      <ThemeProvider>
        <I18nProvider initialOverride={initialLocale}>
          <SessionProvider>
            <RouterProvider>
              <Root />
            </RouterProvider>
          </SessionProvider>
        </I18nProvider>
      </ThemeProvider>
    </PersistQueryClientProvider>
  );
}
