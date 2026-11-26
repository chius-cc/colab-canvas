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
import { ApiError, imagesApi } from "@/lib/api";
import { cn, formatTimestamp } from "@/lib/utils";
import type {
  AuthUser,
  ImageRecord,
  RemixDraft,
  WorkflowManifest,
} from "@/types/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
  onRemixInStudio: (draft: RemixDraft) => void;
  onImageDeleted?: () => void;
}

const PAGE_LIMIT = 40;

function uploadBadge(state: ImageRecord["upload_state"]) {
  if (state === "uploaded") return <Badge variant="sage">uploaded</Badge>;
  if (state === "failed") return <Badge variant="vermilion">upload failed</Badge>;
  return <Badge variant="ochre">pending outbox</Badge>;
}

export function GalleryView({
  user,
  workflows,
  refreshSignal,
  onRemixInStudio,
  onImageDeleted,
}: GalleryViewProps) {
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
      setError(err instanceof ApiError ? err.detail : "Failed to load gallery.");
    } finally {
      setLoading(false);
    }
  }, [offset, mineOnly, favoriteOnly, variantFilter]);

  useEffect(() => {
    void fetchImages();
  }, [fetchImages, refreshSignal]);

  const handleToggleFavorite = async (img: ImageRecord) => {
    const canModify = img.user_id === user.id || user.role === "admin";
    if (!canModify) return;
    try {
      const res = await imagesApi.setFavorite(img.id, !img.is_favorite);
      setImages((prev) =>
        prev.map((item) => (item.id === img.id ? res.image : item))
      );
      if (selectedImage?.id === img.id) {
        setSelectedImage(res.image);
      }
    } catch (err) {
      setError(
        err instanceof ApiError ? err.detail : "Could not update favorite state."
      );
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
      setError(
        err instanceof ApiError ? err.detail : "Failed to delete image."
      );
    } finally {
      setDeleting(false);
    }
  };

  const handleRemix = (img: ImageRecord) => {
    const wf = workflows.find((w) => w.id === img.workflow_id) ?? workflows[0];
    const variantDefaults = wf?.variants[img.variant]?.defaults;
    const draft: RemixDraft = {
      workflow_id: img.workflow_id,
      variant: img.variant,
      prompt: img.meta.prompt ?? "",
      negative_prompt:
        img.meta.negative_prompt ?? variantDefaults?.negative_prompt ?? "",
      width: img.meta.width || img.width || 1024,
      height: img.meta.height || img.height || 1024,
      steps: img.meta.steps ?? variantDefaults?.steps ?? 10,
      cfg: img.meta.cfg ?? variantDefaults?.cfg ?? 1.0,
      sampler_name:
        img.meta.sampler_name ?? variantDefaults?.sampler_name ?? "euler",
      scheduler: img.meta.scheduler ?? variantDefaults?.scheduler ?? "simple",
      seed: img.meta.seed ?? img.seed,
      loras: (img.meta.loras ?? []).map((l) => ({
        id: l.id,
        filename: l.filename,
        name: l.name,
        strength: l.strength,
      })),
      gpu_type: img.meta.gpu_type ?? "L4",
      sourceImageId: img.id,
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
      // Clipboard blocked in non-HTTPS contexts
    }
  };

  return (
    <div className="space-y-4">
      {/* Filter Bar */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1 rounded-md border border-[#E7E5E0] bg-[#FAF9F6] p-0.5 text-xs">
              <button
                type="button"
                onClick={() => {
                  setOffset(0);
                  setMineOnly(false);
                }}
                className={cn(
                  "rounded-sm px-3 py-1 font-medium transition-colors",
                  !mineOnly
                    ? "bg-[#FFFFFF] text-[#1C1917] shadow-2xs"
                    : "text-[#78716C] hover:text-[#1C1917]"
                )}
              >
                All Works
              </button>
              <button
                type="button"
                onClick={() => {
                  setOffset(0);
                  setMineOnly(true);
                }}
                className={cn(
                  "rounded-sm px-3 py-1 font-medium transition-colors",
                  mineOnly
                    ? "bg-[#FFFFFF] text-[#1C1917] shadow-2xs"
                    : "text-[#78716C] hover:text-[#1C1917]"
                )}
              >
                My Works
              </button>
            </div>

            <div className="w-40">
              <Select
                value={variantFilter}
                onValueChange={(v) => {
                  setOffset(0);
                  setVariantFilter(v);
                }}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="All variants" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All variants</SelectItem>
                  {variantChoices.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2 rounded-md border border-[#E7E5E0] bg-[#FAF9F6] px-2.5 py-1">
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
                className="cursor-pointer text-xs text-[#44403C]"
              >
                Favorites only
              </Label>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="font-mono text-xs text-[#78716C] tabular-nums">
              {total} {total === 1 ? "image" : "images"}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void fetchImages()}
              disabled={loading}
              className="h-8 text-xs"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              Refresh
            </Button>
          </div>
        </div>
      </Card>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-[#E8C9C8] bg-[#FBF0F0] px-4 py-2.5 text-xs text-[#A84442]"
        >
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Grid */}
      {!loading && images.length === 0 ? (
        <Card className="flex min-h-[320px] flex-col items-center justify-center p-8 text-center">
          <ImageIcon className="h-8 w-8 text-[#78716C]/70" />
          <p className="mt-3 text-sm font-medium text-[#1C1917]">
            No artworks match these filters
          </p>
          <p className="mt-1 text-xs text-[#78716C]">
            Generate new images in Studio or relax the filter toggles above.
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {images.map((img) => {
            const canModify = img.user_id === user.id || user.role === "admin";
            return (
              <Card
                key={img.id}
                className="group overflow-hidden transition-colors hover:border-[#D6D3CB]"
              >
                <div className="relative aspect-[4/5] bg-[#F5F3EE] overflow-hidden">
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmDeleteId(null);
                      setSelectedImage(img);
                    }}
                    className="block h-full w-full focus:outline-none"
                    aria-label={`Open image ${img.id}`}
                  >
                    <img
                      src={img.thumb_url}
                      alt={img.meta.prompt || "Generated artwork"}
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                    />
                  </button>

                  {canModify && (
                    <button
                      type="button"
                      onClick={() => void handleToggleFavorite(img)}
                      aria-label={
                        img.is_favorite ? "Remove favorite" : "Favorite image"
                      }
                      className={cn(
                        "absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full border transition-all",
                        img.is_favorite
                          ? "border-[#E8D0D3] bg-[#FAF1F2] text-[#B87E84]"
                          : "border-[#E7E5E0]/80 bg-[#FFFFFF]/85 text-[#78716C] opacity-0 group-hover:opacity-100 hover:text-[#B87E84]"
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

                  <div className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-1">
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full border border-white/80",
                        img.upload_state === "uploaded" && "bg-[#3D7A5A]",
                        img.upload_state === "pending" && "bg-[#9C6D2E]",
                        img.upload_state === "failed" && "bg-[#A84442]"
                      )}
                      title={`Storage: ${img.upload_state}`}
                    />
                  </div>
                </div>

                <div className="px-3 py-2.5 space-y-1">
                  <div className="flex items-center justify-between gap-1.5">
                    <Badge variant="neutral" className="font-mono text-[10px] px-1.5 py-0">
                      {img.variant}
                    </Badge>
                    <span className="font-mono text-[10px] text-[#78716C] tabular-nums">
                      {img.width}×{img.height}
                    </span>
                  </div>
                  <p className="truncate text-[11px] text-[#44403C]">
                    {img.meta.prompt || "Untitled"}
                  </p>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {total > PAGE_LIMIT && (
        <div className="flex items-center justify-between rounded-lg border border-[#E7E5E0] bg-[#FFFFFF] px-4 py-2.5 text-xs">
          <span className="font-mono text-[#78716C] tabular-nums">
            Showing {offset + 1}–{Math.min(offset + images.length, total)} of{" "}
            {total}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_LIMIT))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE_LIMIT >= total}
              onClick={() => setOffset((o) => o + PAGE_LIMIT)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Full-Resolution Modal Viewer + Metadata Drawer */}
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
              <div className="flex items-center justify-center bg-[#F5F3EE] p-4 md:col-span-7 overflow-auto">
                <img
                  src={selectedImage.original_url}
                  alt={selectedImage.meta.prompt || "Full resolution artwork"}
                  className="max-h-[78vh] w-auto rounded border border-[#E7E5E0] object-contain shadow-xs"
                />
              </div>

              <div className="flex flex-col justify-between border-t border-[#E7E5E0] bg-[#FFFFFF] md:col-span-5 md:border-l md:border-t-0 max-h-[88vh] overflow-y-auto">
                <div className="space-y-4 p-5">
                  <DialogHeader className="border-0 p-0 pr-6">
                    <div className="flex flex-wrap items-center gap-2">
                      <DialogTitle className="font-mono text-sm">
                        {selectedImage.workflow_id}/{selectedImage.variant}
                      </DialogTitle>
                      {uploadBadge(selectedImage.upload_state)}
                    </div>
                    <DialogDescription>
                      by {selectedImage.username} ·{" "}
                      {formatTimestamp(selectedImage.created_at)}
                    </DialogDescription>
                  </DialogHeader>

                  <div className="space-y-1.5">
                    <Label className="text-[11px] uppercase tracking-wider text-[#78716C]">
                      Prompt
                    </Label>
                    <p className="rounded-md border border-[#E7E5E0] bg-[#FAF9F6] p-2.5 text-xs leading-relaxed text-[#1C1917] whitespace-pre-wrap">
                      {selectedImage.meta.prompt}
                    </p>
                  </div>

                  {selectedImage.meta.negative_prompt && (
                    <div className="space-y-1.5">
                      <Label className="text-[11px] uppercase tracking-wider text-[#78716C]">
                        Negative Prompt
                      </Label>
                      <p className="rounded-md border border-[#E7E5E0] bg-[#FAF9F6] p-2.5 text-xs leading-relaxed text-[#44403C] whitespace-pre-wrap">
                        {selectedImage.meta.negative_prompt}
                      </p>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2.5 rounded-md border border-[#E7E5E0] bg-[#FAF9F6] p-3 text-xs">
                    <div>
                      <span className="block text-[10px] text-[#78716C]">
                        Dimensions
                      </span>
                      <span className="font-mono font-medium tabular-nums">
                        {selectedImage.width} × {selectedImage.height}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[10px] text-[#78716C]">
                        Seed
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleCopySeed(selectedImage.seed)}
                        className="inline-flex items-center gap-1 font-mono font-medium text-[#1C1917] hover:text-[#4A6580] tabular-nums"
                      >
                        {selectedImage.seed}
                        {copiedSeed ? (
                          <Check className="h-3 w-3 text-[#3D7A5A]" />
                        ) : (
                          <Copy className="h-3 w-3 text-[#78716C]" />
                        )}
                      </button>
                    </div>
                    <div>
                      <span className="block text-[10px] text-[#78716C]">
                        Steps / CFG
                      </span>
                      <span className="font-mono font-medium tabular-nums">
                        {selectedImage.meta.steps ?? "default"} /{" "}
                        {selectedImage.meta.cfg ?? "default"}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[10px] text-[#78716C]">
                        Sampler / Scheduler
                      </span>
                      <span className="font-mono font-medium">
                        {selectedImage.meta.sampler_name ?? "default"} ·{" "}
                        {selectedImage.meta.scheduler ?? "default"}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[10px] text-[#78716C]">
                        GPU Tier
                      </span>
                      <span className="font-mono font-medium">
                        {selectedImage.meta.gpu_type || "L4"}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[10px] text-[#78716C]">
                        Storage
                      </span>
                      <span className="font-mono font-medium">
                        {selectedImage.storage_backend}
                      </span>
                    </div>
                  </div>

                  {selectedImage.meta.loras &&
                    selectedImage.meta.loras.length > 0 && (
                      <div className="space-y-1.5">
                        <Label className="text-[11px] uppercase tracking-wider text-[#78716C]">
                          LoRAs
                        </Label>
                        <div className="flex flex-wrap gap-1.5">
                          {selectedImage.meta.loras.map((l) => (
                            <Badge key={l.filename} variant="slate" className="font-mono">
                              {l.name || l.filename} @ {l.strength}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}

                  {selectedImage.upload_error && (
                    <div className="rounded-md border border-[#E8C9C8] bg-[#FBF0F0] px-3 py-2 text-[11px] text-[#A84442]">
                      Upload error (attempts: {selectedImage.upload_attempts}):{" "}
                      {selectedImage.upload_error}
                    </div>
                  )}
                </div>

                <div className="border-t border-[#E7E5E0] bg-[#FAF9F6] p-4 space-y-2.5">
                  <Button
                    onClick={() => handleRemix(selectedImage)}
                    className="w-full"
                  >
                    <Sparkles />
                    Remix in Studio
                  </Button>

                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" asChild className="flex-1">
                      <a
                        href={selectedImage.original_url}
                        download={`colab-canvas-${selectedImage.id.slice(0, 8)}.png`}
                      >
                        <Download />
                        Original PNG
                      </a>
                    </Button>

                    {(selectedImage.user_id === user.id ||
                      user.role === "admin") && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleToggleFavorite(selectedImage)}
                        >
                          <Heart
                            className={cn(
                              "h-3.5 w-3.5",
                              selectedImage.is_favorite &&
                                "fill-[#B87E84] text-[#B87E84]"
                            )}
                          />
                          {selectedImage.is_favorite ? "Favorited" : "Favorite"}
                        </Button>

                        {confirmDeleteId === selectedImage.id ? (
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={deleting}
                            onClick={() => void handleDelete(selectedImage)}
                          >
                            {deleting ? "Deleting..." : "Confirm"}
                          </Button>
                        ) : (
                          <Button
                            variant="destructiveOutline"
                            size="sm"
                            onClick={() => setConfirmDeleteId(selectedImage.id)}
                          >
                            <Trash2 />
                            Delete
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
