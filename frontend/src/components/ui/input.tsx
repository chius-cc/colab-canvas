import * as React from "react";
import { cn } from "@/lib/utils";

export function Input({
  className,
  type = "text",
  ...props
}: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      className={cn(
        "flex h-9 w-full rounded-md border border-[#E5E0D6] bg-[#FFFFFF] px-3 py-1.5 text-sm text-[#1A1D24] placeholder:text-[#62666F]/70 transition-colors focus-visible:outline-none focus-visible:border-[#C85642] focus-visible:ring-2 focus-visible:ring-[#C85642]/18 disabled:cursor-not-allowed disabled:bg-[#F2EFE9] disabled:opacity-65",
        className
      )}
      {...props}
    />
  );
}
