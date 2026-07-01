"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function NavLink({
  href,
  children,
  className = "",
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  const pathname = usePathname();
  const isActive = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={`focus-ring flex min-h-11 items-center rounded-md px-2.5 py-1.5 text-[13px] transition-colors ${
        isActive
          ? "bg-accent/10 font-medium text-accent"
          : "text-stone-400 hover:bg-stone-800/40 hover:text-stone-200"
      } ${className}`}
    >
      {children}
    </Link>
  );
}
