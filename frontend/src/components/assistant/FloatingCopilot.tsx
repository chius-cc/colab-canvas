import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  AlertCircle,
  Loader2,
  Maximize2,
  MessageSquareText,
  Send,
  Settings,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { useI18n } from "@/i18n";
import { parseAssistantContent } from "@/lib/recipeParser";
import type {
  AssistantChatMode,
  AssistantStatusResponse,
  AuthUser,
  CanvasRecipe,
  ChatThreadMessage,
  JobRecord,
} from "@/types/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageContent } from "@/components/assistant/MessageContent";
import { RecipeCard } from "@/components/assistant/RecipeCard";

interface FloatingCopilotProps {
  user: AuthUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  showStudioChips: boolean;
  assistantStatus: AssistantStatusResponse | null;
  messages: ChatThreadMessage[];
  streaming: boolean;
  jobs: JobRecord[];
  onSendMessage: (text: string, mode?: AssistantChatMode) => Promise<void>;
  onStopStreaming: () => void;
  onApplyRecipeToStudio: (recipe: CanvasRecipe) => void;
  onGenerateFromRecipe: (
    messageId: string,
    recipeIndex: number,
    recipe: CanvasRecipe
  ) => Promise<void>;
  onExpandToInspire: () => void;
  onOpenAssistantSettings: () => void;
  onOpenGallery: () => void;
}

export function FloatingCopilot({
  user,
  open,
  onOpenChange,
  showStudioChips,
  assistantStatus,
  messages,
  streaming,
  jobs,
  onSendMessage,
  onStopStreaming,
  onApplyRecipeToStudio,
  onGenerateFromRecipe,
  onExpandToInspire,
  onOpenAssistantSettings,
  onOpenGallery,
}: FloatingCopilotProps) {
  const { dict } = useI18n();
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [open, messages.length, messages[messages.length - 1]?.content]);

  const isAvailable =
    assistantStatus === null ||
    (assistantStatus.enabled && assistantStatus.configured);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || streaming) return;
    setDraft("");
    await onSendMessage(text, "chat");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      const text = draft.trim();
      if (!text || streaming) return;
      setDraft("");
      void onSendMessage(text, "chat");
    }
  };

  if (!open) {
    return (
      <div className="fixed bottom-5 right-5 z-40">
        <button
          type="button"
          onClick={() => onOpenChange(true)}
          className="inline-flex items-center gap-2 rounded-full border border-[#1A1D24] bg-[#1A1D24] px-4 py-2.5 text-xs font-medium text-white shadow-[0_12px_30px_rgba(26,29,36,0.18)] transition-transform hover:scale-[1.02]"
        >
          <Sparkles className="h-3.5 w-3.5 text-[#ECC5BD]" />
          <span>{dict.chat.copilotTitle}</span>
        </button>
      </div>
    );
  }

  return (
    <aside
      aria-label={dict.chat.copilotTitle}
      className="fixed bottom-5 right-5 z-40 flex h-[540px] max-h-[78vh] w-[400px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-[#D4CEC2] bg-[#FFFFFF] shadow-[0_20px_50px_rgba(26,29,36,0.16)]"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[#E5E0D6] bg-[#FAF8F4] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <MessageSquareText className="h-4 w-4 text-[#C85642]" />
          <span className="text-xs font-semibold text-[#1A1D24]">
            {dict.chat.copilotTitle}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            title={dict.chat.expandToInspire}
            aria-label={dict.chat.expandToInspire}
            onClick={onExpandToInspire}
            className="rounded p-1.5 text-[#62666F] hover:bg-[#F2EFE9] hover:text-[#1A1D24]"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title={dict.chat.closeDrawer}
            aria-label={dict.chat.closeDrawer}
            onClick={() => onOpenChange(false)}
            className="rounded p-1.5 text-[#62666F] hover:bg-[#F2EFE9] hover:text-[#1A1D24]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Studio Quick Chips */}
      {showStudioChips && isAvailable && (
        <div className="flex flex-wrap gap-1.5 border-b border-[#E5E0D6] bg-[#FAF8F4]/70 px-3.5 py-2">
          {dict.chat.quickChips.map((chip) => (
            <button
              key={chip.mode}
              type="button"
              disabled={streaming}
              onClick={() =>
                void onSendMessage(
                  dict.chat.quickChipPrompts[chip.mode],
                  chip.mode
                )
              }
              className="rounded-full border border-[#E5E0D6] bg-[#FFFFFF] px-2.5 py-1 text-[11px] font-medium text-[#1A1D24] transition-colors hover:border-[#C85642] hover:text-[#C85642] disabled:opacity-50"
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-3.5 space-y-3.5 bg-[#FFFFFF]">
        {!isAvailable ? (
          <div className="rounded-lg border border-[#E5D0AD] bg-[#FBF4E8] p-3.5 space-y-2.5 text-xs">
            <div className="font-semibold text-[#1A1D24]">
              {dict.chat.unconfiguredTitle}
            </div>
            <p className="text-[#4A4E58]">{dict.chat.unconfiguredDesc}</p>
            {user.role === "admin" && (
              <Button
                variant="outline"
                size="sm"
                onClick={onOpenAssistantSettings}
                className="h-7 text-xs"
              >
                <Settings className="h-3 w-3" />
                {dict.chat.goToSettings}
              </Button>
            )}
          </div>
        ) : messages.length === 0 ? (
          <div className="space-y-2 py-4">
            {dict.chat.starterIdeas.slice(0, 3).map((idea) => (
              <button
                key={idea.label}
                type="button"
                disabled={streaming}
                onClick={() => void onSendMessage(idea.prompt, "chat")}
                className="block w-full rounded-md border border-[#E5E0D6] bg-[#FAF8F4] px-3 py-2 text-left transition-colors hover:border-[#C85642]"
              >
                <div className="text-xs font-medium text-[#1A1D24]">
                  {idea.label}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-[#62666F]">
                  {idea.prompt}
                </div>
              </button>
            ))}
          </div>
        ) : (
          messages.map((msg) => {
            if (msg.role === "user") {
              return (
                <div key={msg.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-sm border border-[#E5E0D6] bg-[#F2EFE9] px-3 py-2 text-xs leading-relaxed text-[#1A1D24] whitespace-pre-wrap">
                    {msg.content}
                  </div>
                </div>
              );
            }

            const segments = parseAssistantContent(msg.content);
            return (
              <div key={msg.id} className="space-y-2.5">
                {msg.streaming && msg.content.length === 0 && (
                  <div className="flex items-center gap-2 text-xs text-[#62666F]">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-[#C85642]" />
                    <span>{dict.chat.thinking}</span>
                  </div>
                )}

                {segments.map((seg, idx) => {
                  if (seg.kind === "markdown") {
                    return <MessageContent key={idx} text={seg.text} />;
                  }
                  if (seg.kind === "recipe-pending") {
                    return (
                      <div
                        key={idx}
                        className="flex items-center gap-2 rounded-md border border-[#E5E0D6] bg-[#FAF8F4] px-2.5 py-1.5 text-[11px] text-[#62666F]"
                      >
                        <Loader2 className="h-3 w-3 animate-spin text-[#C85642]" />
                        <span>{dict.chat.composingRecipe}</span>
                      </div>
                    );
                  }
                  const linkedJobId = msg.generatedJobs?.[seg.recipeIndex];
                  const linkedJob = linkedJobId
                    ? jobs.find((j) => j.id === linkedJobId) ?? null
                    : null;
                  return (
                    <RecipeCard
                      key={idx}
                      recipe={seg.recipe}
                      compact
                      linkedJob={linkedJob}
                      onApply={onApplyRecipeToStudio}
                      onGenerate={(r) =>
                        onGenerateFromRecipe(msg.id, seg.recipeIndex, r)
                      }
                      onOpenGallery={onOpenGallery}
                    />
                  );
                })}

                {msg.error && (
                  <div className="flex items-start gap-1.5 rounded-md border border-[#EBC1BC] bg-[#FDF0EE] px-2.5 py-2 text-[11px] text-[#B43B2E]">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>{msg.error}</span>
                  </div>
                )}
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </div>

      {/* Footer Input */}
      <form
        onSubmit={handleSubmit}
        className="border-t border-[#E5E0D6] bg-[#FAF8F4] p-2.5"
      >
        <div className="flex items-end gap-2">
          <Textarea
            rows={2}
            placeholder={dict.chat.placeholder}
            value={draft}
            disabled={!isAvailable}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            className="min-h-[44px] resize-none bg-[#FFFFFF] text-xs"
          />
          {streaming ? (
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={dict.chat.stop}
              onClick={onStopStreaming}
            >
              <Square className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              aria-label={dict.chat.send}
              disabled={!isAvailable || !draft.trim()}
            >
              <Send className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </form>
    </aside>
  );
}
