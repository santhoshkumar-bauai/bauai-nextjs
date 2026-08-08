import { cn } from "@/lib/utils";

/**
 * Thin determinate progress bar, generalizing the local ScoreBar in
 * tender-card.tsx. `value` is 0..1.
 */
function Progress({
  value,
  className,
  barClassName,
  ...props
}: React.ComponentProps<"div"> & { value: number; barClassName?: string }) {
  const clamped = Math.min(1, Math.max(0, value));
  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
      {...props}
    >
      <div
        className={cn("h-full rounded-full bg-primary/70 transition-[width]", barClassName)}
        style={{ width: `${clamped * 100}%` }}
      />
    </div>
  );
}

export { Progress };
