import { useState } from "react";
import { ArrowUpRight, Check, Loader2, Sparkles, Wand2 } from "lucide-react";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import type { CanvasRecipe, JobRecord } from "@/types/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface RecipeCardProps {
  recipe: CanvasRecipe;
  compact?: boolean;
  linkedJob?: JobRecord | null;
  onApply: (recipe: CanvasRecipe) => void;
  onGenerate: (recipe: CanvasRecipe) => Promise<void>;
  onCancelJob?: (jobId: string) => Promise<void>;
  onOpenGallery: () => void;
}

export function RecipeCard({
  recipe,
  compact = false,
  linkedJob,
  onApply,
  onGenerate,
  onCancelJob,
  onOpenGallery,
}: RecipeCardProps) {
  const { dict } = useI18n();
  const [applied, setApplied] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleApply = () => {
    onApply(recipe);
    setApplied(true);
    window.setTimeout(() => setApplied(false), 1800);
  };

  const handleGenerate = async () => {
    setSubmitting(true);
    try {
      await onGenerate(recipe);
    } finally {
      setSubmitting(false);
    }
  };

  const isRunning =
    linkedJob?.status === "queued" ||
    linkedJob?.status === "booting" ||
    linkedJob?.status === "running";

  return (
    <div className="rounded-lg border border-[#E5E0D6] bg-[#FAF8F4] p-3.5 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Sparkles className="h-3.5 w-3.5 text-[#C85642] shrink-0" />
          <span className="truncate text-xs font-semibold text-[#1A1D24]">
            {recipe.title || dict.chat.recipeTitleFallback}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1 font-mono text-[10px] text-[#4A4E58] tabular-nums">
          {recipe.variant && (
            <Badge variant="slate" className="px-1.5 py-0 text-[10px]">
              {recipe.variant}
            </Badge>
          )}
          {(recipe.width || recipe.height) && (
            <Badge variant="neutral" className="px-1.5 py-0 text-[10px]">
              {recipe.width ?? 1024}×{recipe.height ?? 1024}
            </Badge>
          )}
          {recipe.steps !== undefined && (
            <Badge variant="neutral" className="px-1.5 py-0 text-[10px]">
              {recipe.steps}s
            </Badge>
          )}
          {recipe.cfg !== undefined && (
            <Badge variant="neutral" className="px-1.5 py-0 text-[10px]">
              CFG {recipe.cfg}
            </Badge>
          )}
        </div>
      </div>

      <p
        className={cn(
          "rounded-md border border-[#E5E0D6] bg-[#FFFFFF] px-2.5 py-2 text-xs leading-relaxed text-[#1A1D24]",
          compact && "line-clamp-3"
        )}
      >
        {recipe.prompt}
      </p>

      {recipe.loras && recipe.loras.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {recipe.loras.map((l) => (
            <Badge key={l.id} variant="neutral" className="font-mono text-[10px]">
              LoRA {l.id.slice(0, 8)} @ {l.strength ?? 0.8}
            </Badge>
          ))}
        </div>
      )}

      {linkedJob && (
        <div className="space-y-2 rounded-md border border-[#E5E0D6] bg-[#FFFFFF] p-2.5">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="font-medium text-[#1A1D24]">
              {dict.studio.status[linkedJob.status]}
            </span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[#62666F] tabular-nums">
                {Math.round(linkedJob.progress * 100)}%
              </span>
              {onCancelJob &&
                (linkedJob.status === "queued" ||
                  linkedJob.status === "booting") && (
                  <button
                    type="button"
                    onClick={() => void onCancelJob(linkedJob.id)}
                    className="text-[11px] font-medium text-[#B43B2E] hover:underline"
                  >
                    {dict.studio.cancelJob}
                  </button>
                )}
            </div>
          </div>
          {isRunning && linkedJob.stage_detail && (
            <p className="text-[11px] text-[#4A4E58]">
              {linkedJob.stage_detail}
            </p>
          )}
          {isRunning && (
            <div className="h-1 w-full overflow-hidden rounded-full bg-[#E5E0D6]">
              <div
                className="h-full rounded-full bg-[#C85642] transition-all duration-300"
                style={{
                  width: `${Math.max(10, Math.round(linkedJob.progress * 100))}%`,
                }}
              />
            </div>
          )}
          {linkedJob.status === "failed" && linkedJob.error_msg && (
            <p className="text-[11px] text-[#B43B2E] break-all">
              {linkedJob.error_msg}
            </p>
          )}
          {linkedJob.image_ids.length > 0 && (
            <div className="space-y-1.5">
              <div className="grid grid-cols-2 gap-2">
                {linkedJob.image_ids.map((imgId) => (
                  <img
                    key={imgId}
                    src={`/api/images/${imgId}/thumb`}
                    alt={recipe.prompt}
                    className="h-28 w-full rounded border border-[#E5E0D6] object-cover bg-[#F2EFE9]"
                  />
                ))}
              </div>
              <button
                type="button"
                onClick={onOpenGallery}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-[#3E5C76] hover:underline"
              >
                {dict.chat.openInGallery}
                <ArrowUpRight className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        <Button
          size="sm"
          disabled={submitting || isRunning}
          onClick={() => void handleGenerate()}
          className="h-8 text-xs"
        >
          {submitting || isRunning ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {dict.chat.generating}
            </>
          ) : (
            <>
              <Sparkles className="h-3.5 w-3.5" />
              {dict.chat.generateNow}
            </>
          )}
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={handleApply}
          className="h-8 text-xs"
        >
          {applied ? (
            <>
              <Check className="h-3.5 w-3.5 text-[#2F6F52]" />
              {dict.chat.appliedNotice}
            </>
          ) : (
            <>
              <Wand2 className="h-3.5 w-3.5" />
              {compact ? dict.chat.applyInDrawer : dict.chat.applyToStudio}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
