import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  Heart,
  ImageIcon,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { interpolate, useI18n } from "@/i18n";
import { ApiError, imagesApi } from "@/lib/api";
import { cn, formatTimestamp } from "@/lib/utils";
import type {
  AuthUser,
  ImageRecord,
  StudioDraft,
  WorkflowManifest,
} from "@/types/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

interface GalleryViewProps {
  user: AuthUser;
  workflows: WorkflowManifest[];
  refreshSignal: number;
  onRemixInStudio: (draft: StudioDraft) => void;
  onImageDeleted?: () => void;
}

const PAGE_LIMIT = 40;

export function GalleryView({
  user,
  workflows,
  refreshSignal,
  onRemixInStudio,
  onImageDeleted,
}: GalleryViewProps) {
  const { dict } = useI18n();
  const [images, setImages] = useState<ImageRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [mineOnly, setMineOnly] = useState(false);
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [variantFilter, setVariantFilter] = useState<string>("__all__");

  const [selectedImage, setSelectedImage] = useState<ImageRecord | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [copiedSeed, setCopiedSeed] = useState(false);

  const variantChoices = useMemo(() => {
    const keys = new Set<string>();
    for (const wf of workflows) {
      for (const [key, spec] of Object.entries(wf.variants)) {
        if (user.role === "admin" || !spec.admin_only) {
          keys.add(key);
        }
      }
    }
    return Array.from(keys);
  }, [workflows, user.role]);

  const fetchImages = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await imagesApi.list({
        limit: PAGE_LIMIT,
        offset,
        mine: mineOnly || undefined,
        favorite: favoriteOnly || undefined,
        variant: variantFilter !== "__all__" ? variantFilter : undefined,
      });
      setImages(res.images);
      setTotal(res.total);
      setSelectedImage((prev) =>
        prev ? res.images.find((img) => img.id === prev.id) ?? prev : null
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Failed to load gallery");
    } finally {
      setLoading(false);
    }
  }, [offset, mineOnly, favoriteOnly, variantFilter]);

  useEffect(() => {
    void fetchImages();
  }, [fetchImages, refreshSignal]);

  const handleToggleFavorite = async (img: ImageRecord) => {
    if (img.user_id !== user.id && user.role !== "admin") return;
    try {
      const res = await imagesApi.setFavorite(img.id, !img.is_favorite);
      setImages((prev) =>
        prev.map((item) => (item.id === img.id ? res.image : item))
      );
      if (selectedImage?.id === img.id) {
        setSelectedImage(res.image);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Update failed");
    }
  };

  const handleDelete = async (img: ImageRecord) => {
    setDeleting(true);
    setError(null);
    try {
      await imagesApi.remove(img.id);
      setImages((prev) => prev.filter((item) => item.id !== img.id));
      setTotal((t) => Math.max(0, t - 1));
      setSelectedImage(null);
      setConfirmDeleteId(null);
      onImageDeleted?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  const handleRemix = (img: ImageRecord) => {
    const wf = workflows.find((w) => w.id === img.workflow_id) ?? workflows[0];
    const defaults = wf?.variants[img.variant]?.defaults;
    const draft: StudioDraft = {
      workflow_id: img.workflow_id,
      variant: img.variant,
      prompt: img.meta.prompt ?? "",
      negative_prompt:
        img.meta.negative_prompt ?? defaults?.negative_prompt ?? "",
      width: img.meta.width || img.width || 1024,
      height: img.meta.height || img.height || 1024,
      steps: img.meta.steps ?? defaults?.steps ?? 10,
      cfg: img.meta.cfg ?? defaults?.cfg ?? 1.0,
      sampler_name: img.meta.sampler_name ?? defaults?.sampler_name ?? "euler",
      scheduler: img.meta.scheduler ?? defaults?.scheduler ?? "simple",
      seed: img.meta.seed ?? img.seed,
      loras: (img.meta.loras ?? []).map((l) => ({
        id: l.id,
        filename: l.filename,
        name: l.name,
        strength: l.strength,
      })),
      gpu_type: img.meta.gpu_type ?? "L4",
      sourceLabel: img.id.slice(0, 8),
    };
    setSelectedImage(null);
    onRemixInStudio(draft);
  };

  const handleCopySeed = async (seed: number) => {
    try {
      await navigator.clipboard.writeText(String(seed));
      setCopiedSeed(true);
      window.setTimeout(() => setCopiedSeed(false), 1500);
    } catch {
      // Clipboard blocked
    }
  };

  return (
    <div className="space-y-4">
      {/* Minimal Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E5E0D6] pb-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-0.5 rounded-full border border-[#E5E0D6] bg-[#F2EFE9] p-0.5 text-xs">
            <button
              type="button"
              onClick={() => {
                setOffset(0);
                setMineOnly(false);
              }}
              className={cn(
                "rounded-full px-3 py-1 font-medium transition-colors",
                !mineOnly
                  ? "bg-[#FFFFFF] text-[#1A1D24]"
                  : "text-[#62666F] hover:text-[#1A1D24]"
              )}
            >
              {dict.gallery.allWorks}
            </button>
            <button
              type="button"
              onClick={() => {
                setOffset(0);
                setMineOnly(true);
              }}
              className={cn(
                "rounded-full px-3 py-1 font-medium transition-colors",
                mineOnly
                  ? "bg-[#FFFFFF] text-[#1A1D24]"
                  : "text-[#62666F] hover:text-[#1A1D24]"
              )}
            >
              {dict.gallery.myWorks}
            </button>
          </div>

          <div className="w-36">
            <Select
              value={variantFilter}
              onValueChange={(v) => {
                setOffset(0);
                setVariantFilter(v);
              }}
            >
              <SelectTrigger className="h-8 rounded-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">
                  {dict.gallery.allVariants}
                </SelectItem>
                {variantChoices.map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2 rounded-full border border-[#E5E0D6] bg-[#FFFFFF] px-3 py-1">
            <Switch
              id="gallery-favorites"
              checked={favoriteOnly}
              onCheckedChange={(checked) => {
                setOffset(0);
                setFavoriteOnly(checked);
              }}
            />
            <Label
              htmlFor="gallery-favorites"
              className="cursor-pointer text-xs text-[#4A4E58]"
            >
              {dict.gallery.favoritesOnly}
            </Label>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-[#62666F] tabular-nums">
            {interpolate(dict.gallery.imageCount, { count: total })}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchImages()}
            disabled={loading}
            className="h-8 rounded-full text-xs"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", loading && "animate-spin")}
            />
            {dict.app.refresh}
          </Button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-[#EBC1BC] bg-[#FDF0EE] px-4 py-2.5 text-xs text-[#B43B2E]"
        >
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Edge-to-edge Artwork Showcase */}
      {!loading && images.length === 0 ? (
        <div className="flex min-h-[360px] flex-col items-center justify-center rounded-lg border border-dashed border-[#D4CEC2] bg-[#FFFFFF] p-8 text-center">
          <ImageIcon className="h-7 w-7 text-[#62666F]/70" />
          <p className="mt-3 font-display text-base font-medium text-[#1A1D24]">
            {dict.gallery.emptyTitle}
          </p>
          <p className="mt-1 text-xs text-[#62666F]">
            {dict.gallery.emptyDesc}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {images.map((img) => {
            const canModify =
              img.user_id === user.id || user.role === "admin";
            return (
              <div
                key={img.id}
                className="group relative aspect-[4/5] overflow-hidden rounded-lg border border-[#E5E0D6] bg-[#F2EFE9]"
              >
                <button
                  type="button"
                  onClick={() => {
                    setConfirmDeleteId(null);
                    setSelectedImage(img);
                  }}
                  aria-label={`Open image ${img.id}`}
                  className="block h-full w-full focus:outline-none"
                >
                  <img
                    src={img.thumb_url}
                    alt={img.meta.prompt || "Artwork"}
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                  />
                </button>

                {/* Top right favorite button */}
                {canModify && (
                  <button
                    type="button"
                    onClick={() => void handleToggleFavorite(img)}
                    aria-label={
                      img.is_favorite
                        ? dict.gallery.favorited
                        : dict.gallery.favorite
                    }
                    className={cn(
                      "absolute right-2.5 top-2.5 inline-flex h-7 w-7 items-center justify-center rounded-full border transition-all",
                      img.is_favorite
                        ? "border-[#ECC5BD] bg-[#FDF1EE] text-[#C85642]"
                        : "border-white/40 bg-[#1A1D24]/45 text-white opacity-0 group-hover:opacity-100 hover:bg-[#1A1D24]/70"
                    )}
                  >
                    <Heart
                      className={cn(
                        "h-3.5 w-3.5",
                        img.is_favorite && "fill-current"
                      )}
                    />
                  </button>
                )}

                {/* Hover metadata scrim */}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col justify-end bg-gradient-to-t from-[#1A1D24]/80 via-[#1A1D24]/35 to-transparent p-3 pt-10 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                  <div className="flex items-center justify-between gap-2 text-[10px] font-mono text-white/90">
                    <span>{img.variant}</span>
                    <span className="tabular-nums">
                      {img.width}×{img.height}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-white">
                    {img.meta.prompt}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {total > PAGE_LIMIT && (
        <div className="flex items-center justify-between border-t border-[#E5E0D6] pt-3 text-xs">
          <span className="font-mono text-[#62666F] tabular-nums">
            {interpolate(dict.gallery.showingRange, {
              from: offset + 1,
              to: Math.min(offset + images.length, total),
              total,
            })}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_LIMIT))}
            >
              {dict.gallery.prevPage}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE_LIMIT >= total}
              onClick={() => setOffset((o) => o + PAGE_LIMIT)}
            >
              {dict.gallery.nextPage}
            </Button>
          </div>
        </div>
      )}

      {/* Full-Resolution Lightbox Modal */}
      <Dialog
        open={selectedImage !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedImage(null);
            setConfirmDeleteId(null);
          }
        }}
      >
        <DialogContent className="max-w-5xl p-0 overflow-hidden">
          {selectedImage && (
            <div className="grid max-h-[88vh] grid-cols-1 md:grid-cols-12">
              <div className="flex items-center justify-center bg-[#F2EFE9] p-4 md:col-span-7 overflow-auto">
                <img
                  src={selectedImage.original_url}
                  alt={selectedImage.meta.prompt || "Full resolution"}
                  className="max-h-[78vh] w-auto rounded border border-[#E5E0D6] object-contain"
                />
              </div>

              <div className="flex flex-col justify-between border-t border-[#E5E0D6] bg-[#FFFFFF] md:col-span-5 md:border-l md:border-t-0 max-h-[88vh] overflow-y-auto">
                <div className="space-y-4 p-5">
                  <DialogHeader className="border-0 p-0 pr-6">
                    <div className="flex flex-wrap items-center gap-2">
                      <DialogTitle className="font-mono text-sm">
                        {selectedImage.workflow_id}/{selectedImage.variant}
                      </DialogTitle>
                      <Badge
                        variant={
                          selectedImage.upload_state === "uploaded"
                            ? "sage"
                            : selectedImage.upload_state === "failed"
                            ? "vermilion"
                            : "ochre"
                        }
                      >
                        {dict.gallery.uploadState[selectedImage.upload_state]}
                      </Badge>
                    </div>
                    <DialogDescription>
                      {selectedImage.username} ·{" "}
                      {formatTimestamp(selectedImage.created_at)}
                    </DialogDescription>
                  </DialogHeader>

                  <div className="space-y-1">
                    <Label className="text-[11px] text-[#62666F]">
                      {dict.gallery.prompt}
                    </Label>
                    <p className="rounded-md border border-[#E5E0D6] bg-[#FAF8F4] p-2.5 text-xs leading-relaxed text-[#1A1D24] whitespace-pre-wrap">
                      {selectedImage.meta.prompt}
                    </p>
                  </div>

                  {selectedImage.meta.negative_prompt && (
                    <div className="space-y-1">
                      <Label className="text-[11px] text-[#62666F]">
                        {dict.gallery.negativePrompt}
                      </Label>
                      <p className="rounded-md border border-[#E5E0D6] bg-[#FAF8F4] p-2.5 text-xs leading-relaxed text-[#4A4E58] whitespace-pre-wrap">
                        {selectedImage.meta.negative_prompt}
                      </p>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2.5 rounded-md border border-[#E5E0D6] bg-[#FAF8F4] p-3 text-xs">
                    <div>
                      <span className="block text-[10px] text-[#62666F]">
                        {dict.gallery.dimensions}
                      </span>
                      <span className="font-mono font-medium tabular-nums">
                        {selectedImage.width}×{selectedImage.height}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[10px] text-[#62666F]">
                        {dict.gallery.seed}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleCopySeed(selectedImage.seed)}
                        className="inline-flex items-center gap-1 font-mono font-medium text-[#1A1D24] hover:text-[#C85642] tabular-nums"
                      >
                        {selectedImage.seed}
                        {copiedSeed ? (
                          <Check className="h-3 w-3 text-[#2F6F52]" />
                        ) : (
                          <Copy className="h-3 w-3 text-[#62666F]" />
                        )}
                      </button>
                    </div>
                    <div>
                      <span className="block text-[10px] text-[#62666F]">
                        {dict.gallery.stepsCfg}
                      </span>
                      <span className="font-mono font-medium tabular-nums">
                        {selectedImage.meta.steps ?? "—"} /{" "}
                        {selectedImage.meta.cfg ?? "—"}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[10px] text-[#62666F]">
                        {dict.gallery.samplerScheduler}
                      </span>
                      <span className="font-mono font-medium">
                        {selectedImage.meta.sampler_name ?? "—"} ·{" "}
                        {selectedImage.meta.scheduler ?? "—"}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[10px] text-[#62666F]">
                        {dict.gallery.gpu}
                      </span>
                      <span className="font-mono font-medium">
                        {selectedImage.meta.gpu_type || "L4"}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[10px] text-[#62666F]">
                        {dict.gallery.storage}
                      </span>
                      <span className="font-mono font-medium">
                        {selectedImage.storage_backend}
                      </span>
                    </div>
                  </div>

                  {selectedImage.meta.loras &&
                    selectedImage.meta.loras.length > 0 && (
                      <div className="space-y-1">
                        <Label className="text-[11px] text-[#62666F]">
                          {dict.gallery.loras}
                        </Label>
                        <div className="flex flex-wrap gap-1.5">
                          {selectedImage.meta.loras.map((l) => (
                            <Badge
                              key={l.filename}
                              variant="slate"
                              className="font-mono"
                            >
                              {l.name || l.filename} @ {l.strength}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}

                  {selectedImage.upload_error && (
                    <div className="rounded-md border border-[#EBC1BC] bg-[#FDF0EE] px-3 py-2 text-[11px] text-[#B43B2E]">
                      {interpolate(dict.gallery.uploadError, {
                        attempts: selectedImage.upload_attempts,
                        error: selectedImage.upload_error,
                      })}
                    </div>
                  )}
                </div>

                <div className="border-t border-[#E5E0D6] bg-[#FAF8F4] p-4 space-y-2">
                  <Button
                    onClick={() => handleRemix(selectedImage)}
                    className="w-full"
                  >
                    <Sparkles />
                    {dict.gallery.remixInStudio}
                  </Button>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      asChild
                      className="flex-1"
                    >
                      <a
                        href={selectedImage.original_url}
                        download={`colab-canvas-${selectedImage.id.slice(
                          0,
                          8
                        )}.png`}
                      >
                        <Download />
                        {dict.gallery.originalPng}
                      </a>
                    </Button>

                    {(selectedImage.user_id === user.id ||
                      user.role === "admin") && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            void handleToggleFavorite(selectedImage)
                          }
                        >
                          <Heart
                            className={cn(
                              "h-3.5 w-3.5",
                              selectedImage.is_favorite &&
                                "fill-[#C85642] text-[#C85642]"
                            )}
                          />
                          {selectedImage.is_favorite
                            ? dict.gallery.favorited
                            : dict.gallery.favorite}
                        </Button>

                        {confirmDeleteId === selectedImage.id ? (
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={deleting}
                            onClick={() => void handleDelete(selectedImage)}
                          >
                            {deleting
                              ? dict.gallery.deleting
                              : dict.app.confirm}
                          </Button>
                        ) : (
                          <Button
                            variant="destructiveOutline"
                            size="sm"
                            onClick={() =>
                              setConfirmDeleteId(selectedImage.id)
                            }
                          >
                            <Trash2 />
                            {dict.app.delete}
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
