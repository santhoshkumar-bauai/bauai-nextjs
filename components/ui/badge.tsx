import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Small status pill, generalizing the hand-rolled STATUS_STYLES /
 * VERDICT_STYLES maps in the tender components. Colors follow the existing
 * ring-inset pattern there.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        success: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
        warning: "bg-amber-50 text-amber-800 ring-amber-600/25",
        info: "bg-sky-50 text-sky-700 ring-sky-600/20",
        danger: "bg-rose-50 text-rose-700 ring-rose-600/20",
        neutral: "bg-muted text-muted-foreground ring-border",
        primary: "bg-primary/10 text-primary ring-primary/20",
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  },
);

function Badge({
  className,
  variant = "neutral",
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant, className }))}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
