/** Page heading of one settings section — the route's single `h1`. */
export function SectionHeader({ title }: { title: string }) {
  return (
    <header className="mb-6">
      <h1 className="text-title text-ink">{title}</h1>
    </header>
  );
}
