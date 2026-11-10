"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { ASSISTANT_APPROVALS } from "../../lib/home";

/** /assistant has no page of its own: it opens Approvals. */
export default function AssistantIndexPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace(ASSISTANT_APPROVALS);
  }, [router]);
  return null;
}
