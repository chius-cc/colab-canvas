import type { CanvasRecipe } from "@/types/api";

export type MessageSegment =
  | { kind: "markdown"; text: string }
  | { kind: "recipe"; recipe: CanvasRecipe; recipeIndex: number }
  | { kind: "recipe-pending" };

function normalizeRecipe(raw: unknown): CanvasRecipe | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const prompt = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
  if (!prompt) return null;

  const recipe: CanvasRecipe = { prompt };
  if (typeof obj.title === "string" && obj.title.trim()) {
    recipe.title = obj.title.trim();
  }
  if (typeof obj.negative_prompt === "string") {
    recipe.negative_prompt = obj.negative_prompt.trim();
  }
  if (typeof obj.variant === "string" && obj.variant.trim()) {
    recipe.variant = obj.variant.trim();
  }
  if (typeof obj.width === "number" && Number.isFinite(obj.width)) {
    recipe.width = Math.round(obj.width);
  }
  if (typeof obj.height === "number" && Number.isFinite(obj.height)) {
    recipe.height = Math.round(obj.height);
  }
  if (typeof obj.steps === "number" && Number.isFinite(obj.steps)) {
    recipe.steps = Math.round(obj.steps);
  }
  if (typeof obj.cfg === "number" && Number.isFinite(obj.cfg)) {
    recipe.cfg = Number(obj.cfg.toFixed(2));
  }
  if (Array.isArray(obj.loras)) {
    const loras: Array<{ id: string; strength?: number }> = [];
    for (const item of obj.loras) {
      if (item && typeof item === "object") {
        const id = (item as { id?: unknown }).id;
        const strength = (item as { strength?: unknown }).strength;
        if (typeof id === "string" && id.trim()) {
          loras.push({
            id: id.trim(),
            strength:
              typeof strength === "number" && Number.isFinite(strength)
                ? strength
                : undefined,
          });
        }
      }
    }
    if (loras.length > 0) recipe.loras = loras;
  }
  return recipe;
}

const FENCE_OPEN_RE = /```canvas-recipe[ \t]*\r?\n/g;

export function parseAssistantContent(content: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let cursor = 0;
  let recipeIndex = 0;

  FENCE_OPEN_RE.lastIndex = 0;
  while (cursor < content.length) {
    FENCE_OPEN_RE.lastIndex = cursor;
    const openMatch = FENCE_OPEN_RE.exec(content);
    if (!openMatch) {
      const tail = content.slice(cursor).trim();
      if (tail) segments.push({ kind: "markdown", text: tail });
      break;
    }

    const before = content.slice(cursor, openMatch.index).trim();
    if (before) {
      segments.push({ kind: "markdown", text: before });
    }

    const jsonStart = openMatch.index + openMatch[0].length;
    const closeIdx = content.indexOf("```", jsonStart);
    if (closeIdx === -1) {
      segments.push({ kind: "recipe-pending" });
      break;
    }

    const rawBody = content.slice(jsonStart, closeIdx).trim();
    let parsed: CanvasRecipe | null = null;
    try {
      const cleaned = rawBody.replace(/,\s*([}\]])/g, "$1");
      parsed = normalizeRecipe(JSON.parse(cleaned));
    } catch {
      parsed = null;
    }

    if (parsed) {
      segments.push({ kind: "recipe", recipe: parsed, recipeIndex });
      recipeIndex += 1;
    } else {
      segments.push({
        kind: "markdown",
        text: content.slice(openMatch.index, closeIdx + 3),
      });
    }

    cursor = closeIdx + 3;
  }

  return segments;
}
