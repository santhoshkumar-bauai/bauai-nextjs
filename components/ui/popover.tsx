"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

function Popover(props: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root {...props} />;
}

function PopoverTrigger(props: ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverClose(props: ComponentProps<typeof PopoverPrimitive.Close>) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

/**
 * Anchored panel. `align`/`side`/`sideOffset` are forwarded to the positioner;
 * everything else lands on the popup so callers can size it (`className="w-72"`)
 * the same way they size a DialogContent.
 */
function PopoverContent({
  className,
  align = "start",
  side = "bottom",
  sideOffset = 6,
  alignOffset = 0,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Popup> &
  Pick<
    PopoverPrimitive.Positioner.Props,
    "align" | "side" | "sideOffset" | "alignOffset"
  >) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        side={side}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        className="z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "max-h-[var(--available-height)] origin-[var(--transform-origin)] overflow-y-auto rounded-xl border border-border bg-background p-2 shadow-lg outline-none transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent, PopoverClose };
