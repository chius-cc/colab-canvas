import { useId } from "react";
import { cn } from "@/lib/utils";

interface BrandMarkProps {
  className?: string;
}

/** Custom double-C atelier seal mark for Colab Canvas. */
export function BrandMark({ className }: BrandMarkProps) {
  const uid = useId().replace(/:/g, "");
  const tileGradId = `cc-tile-${uid}`;
  const sealGradId = `cc-seal-${uid}`;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className={cn("h-7 w-7 shrink-0", className)}
    >
      <defs>
        <linearGradient
          id={tileGradId}
          x1="8"
          y1="4"
          x2="56"
          y2="60"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#252934" />
          <stop offset="100%" stopColor="#16181F" />
        </linearGradient>
        <linearGradient
          id={sealGradId}
          x1="20"
          y1="20"
          x2="40"
          y2="44"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#DB6B56" />
          <stop offset="100%" stopColor="#B94532" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill={`url(#${tileGradId})`} />
      <rect
        x="3"
        y="3"
        width="58"
        height="58"
        rx="15"
        stroke="#FAF8F4"
        strokeOpacity={0.14}
        strokeWidth={1.5}
      />
      <path
        d="M43.63 20.62A17 17 0 1 0 43.63 43.38"
        stroke="#FAF8F4"
        strokeWidth={6.4}
        strokeLinecap="round"
      />
      <path
        d="M36.3 25.85A7.8 7.8 0 1 0 36.3 38.15"
        stroke={`url(#${sealGradId})`}
        strokeWidth={5.2}
        strokeLinecap="round"
      />
      <path
        d="M45.5 26.8L46.9 30.6L50.7 32L46.9 33.4L45.5 37.2L44.1 33.4L40.3 32L44.1 30.6Z"
        fill="#EAB964"
      />
    </svg>
  );
}
