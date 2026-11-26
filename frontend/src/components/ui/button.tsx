import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C85642]/40 disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-[#C85642] text-white hover:bg-[#B34734]",
        ink: "bg-[#1A1D24] text-white hover:bg-[#2B303B]",
        slate: "bg-[#3E5C76] text-white hover:bg-[#334C62]",
        secondary:
          "bg-[#F2EFE9] text-[#1A1D24] border border-[#E5E0D6] hover:bg-[#EAE5DC]",
        outline:
          "bg-[#FFFFFF] text-[#1A1D24] border border-[#E5E0D6] hover:bg-[#FAF8F4] hover:border-[#D4CEC2]",
        ghost: "text-[#4A4E58] hover:bg-[#F2EFE9] hover:text-[#1A1D24]",
        destructive: "bg-[#B43B2E] text-white hover:bg-[#992F24]",
        destructiveOutline:
          "bg-[#FDF0EE] text-[#B43B2E] border border-[#EBC1BC] hover:bg-[#F9E2DE]",
      },
      size: {
        default: "h-9 px-3.5 py-2",
        sm: "h-8 rounded-md px-2.5 text-xs",
        lg: "h-10 rounded-md px-5 text-sm",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  type = "button",
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      type={asChild ? undefined : type}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}
