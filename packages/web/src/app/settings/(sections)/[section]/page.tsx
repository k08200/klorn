import { notFound } from "next/navigation";
import { SectionView } from "../../_sections/section-view";
import { isSettingsSectionId, SETTINGS_SECTIONS } from "../../sections";

export const dynamicParams = false;

export function generateStaticParams() {
  return SETTINGS_SECTIONS.map((section) => ({ section: section.id }));
}

export default async function SettingsSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (!isSettingsSectionId(section)) notFound();
  return <SectionView id={section} />;
}
