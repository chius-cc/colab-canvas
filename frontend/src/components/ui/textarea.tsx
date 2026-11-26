import * as React from "react";
import { cn } from "@/lib/utils";

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "flex min-h-[84px] w-full rounded-md border border-[#E7E5E0] bg-[#FFFFFF] px-3 py-2 text-sm text-[#1C1917] placeholder:text-[#78716C]/70 transition-colors focus-visible:outline-none focus-visible:border-[#4A6580] focus-visible:ring-2 focus-visible:ring-[#4A6580]/20 disabled:cursor-not-allowed disabled:bg-[#F5F3EE] disabled:opacity-60",
        className
      )}
      {...props}
    />
  );
}
