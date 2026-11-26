import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 transition-colors",
  {
    variants: {
      variant: {
        neutral: "border-[#E7E5E0] bg-[#F5F3EE] text-[#44403C]",
        slate: "border-[#CBD7E3] bg-[#EFF3F7] text-[#3D546B]",
        sakura: "border-[#E8D0D3] bg-[#FAF1F2] text-[#8F555B]",
        sage: "border-[#C5DFD0] bg-[#EEF6F1] text-[#3D7A5A]",
        ochre: "border-[#E8D7B8] bg-[#FBF5EA] text-[#9C6D2E]",
        vermilion: "border-[#E8C9C8] bg-[#FBF0F0] text-[#A84442]",
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
