export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse bg-slate-100 rounded ${className}`} />;
}

export function CardSkeleton() {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

export function ListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-7 w-10" />
          <Skeleton className="h-2 w-16" />
        </div>
      ))}
    </div>
  );
}
