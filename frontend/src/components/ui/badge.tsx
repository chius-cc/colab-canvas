import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 transition-colors",
  {
    variants: {
      variant: {
        neutral: "border-[#E5E0D6] bg-[#F2EFE9] text-[#4A4E58]",
        slate: "border-[#C8D5E1] bg-[#EFF3F7] text-[#3E5C76]",
        seal: "border-[#ECC5BD] bg-[#FDF1EE] text-[#C85642]",
        sage: "border-[#BBD8C9] bg-[#ECF5F0] text-[#2F6F52]",
        ochre: "border-[#E5D0AD] bg-[#FBF4E8] text-[#8D5B1B]",
        vermilion: "border-[#EBC1BC] bg-[#FDF0EE] text-[#B43B2E]",
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
