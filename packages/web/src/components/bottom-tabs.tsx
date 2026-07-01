"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NavIcon, type NavIconType } from "./nav-icons";

interface Tab {
  href: string;
  label: string;
  icon: NavIconType;
}

const TABS: Tab[] = [
  { href: "/inbox", label: "Queue", icon: "inbox" },
  { href: "/email", label: "Mail", icon: "mail" },
  { href: "/calendar", label: "Calendar", icon: "calendar" },
  { href: "/briefing", label: "Briefing", icon: "bell" },
];

export default function BottomTabs() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary navigation"
      className="md:hidden fixed bottom-0 inset-x-0 z-30 border-t border-stone-700/50 bg-[#10100d]/92 pb-safe shadow-[0_-16px_44px_rgba(0,0,0,0.35)] backdrop-blur-xl"
    >
      <ul className="grid grid-cols-4">
        {TABS.map((tab) => {
          const active = isActive(pathname, tab.href);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`focus-ring flex min-h-[62px] flex-col items-center justify-center gap-1 py-2 text-[10px] transition ${
                  active ? "text-accent" : "text-stone-400"
                }`}
              >
                <NavIcon type={tab.icon} size={22} strokeWidth={active ? 2 : 1.6} />
                <span className={active ? "font-medium" : ""}>{tab.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
