import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4A6580]/40 disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-[#4A6580] text-white hover:bg-[#3D546B] shadow-[0_1px_2px_rgba(28,25,23,0.06)]",
        secondary:
          "bg-[#F5F3EE] text-[#1C1917] border border-[#E7E5E0] hover:bg-[#EDE9E0]",
        outline:
          "bg-[#FFFFFF] text-[#1C1917] border border-[#E7E5E0] hover:bg-[#FAF9F6] hover:border-[#D6D3CB]",
        ghost:
          "text-[#44403C] hover:bg-[#F5F3EE] hover:text-[#1C1917]",
        destructive:
          "bg-[#A84442] text-white hover:bg-[#8F3735]",
        destructiveOutline:
          "bg-[#FBF0F0] text-[#A84442] border border-[#E8C9C8] hover:bg-[#F6E2E2]",
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
