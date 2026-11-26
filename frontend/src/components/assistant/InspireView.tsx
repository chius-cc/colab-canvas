import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  AlertCircle,
  Bot,
  Loader2,
  Send,
  Settings,
  Sparkles,
  Square,
  Trash2,
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageContent } from "@/components/assistant/MessageContent";
import { RecipeCard } from "@/components/assistant/RecipeCard";

interface InspireViewProps {
  user: AuthUser;
  assistantStatus: AssistantStatusResponse | null;
  messages: ChatThreadMessage[];
  streaming: boolean;
  jobs: JobRecord[];
  onSendMessage: (text: string, mode?: AssistantChatMode) => Promise<void>;
  onStopStreaming: () => void;
  onClearChat: () => void;
  onApplyRecipeToStudio: (recipe: CanvasRecipe) => void;
  onGenerateFromRecipe: (
    messageId: string,
    recipeIndex: number,
    recipe: CanvasRecipe
  ) => Promise<void>;
  onOpenAssistantSettings: () => void;
  onOpenGallery: () => void;
}

export function InspireView({
  user,
  assistantStatus,
  messages,
  streaming,
  jobs,
  onSendMessage,
  onStopStreaming,
  onClearChat,
  onApplyRecipeToStudio,
  onGenerateFromRecipe,
  onOpenAssistantSettings,
  onOpenGallery,
}: InspireViewProps) {
  const { dict } = useI18n();
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, messages[messages.length - 1]?.content]);

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

  return (
    <div className="mx-auto max-w-3xl flex flex-col min-h-[calc(100vh-8.5rem)] justify-between gap-4">
      {/* Header strip */}
      <div className="flex items-center justify-between border-b border-[#E5E0D6] pb-3">
        <div className="flex items-center gap-2.5">
          <h1 className="font-display text-xl font-semibold text-[#1A1D24]">
            {dict.chat.title}
          </h1>
          {assistantStatus?.model && assistantStatus.enabled && (
            <Badge variant="neutral" className="font-mono text-[10px]">
              {assistantStatus.model}
            </Badge>
          )}
        </div>

        {messages.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClearChat}
            disabled={streaming}
            className="h-7 px-2.5 text-xs text-[#62666F]"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {dict.chat.clearThread}
          </Button>
        )}
      </div>

      {/* Unconfigured Banner */}
      {!isAvailable && (
        <div className="rounded-lg border border-[#E5D0AD] bg-[#FBF4E8] p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <Bot className="h-4 w-4 text-[#8D5B1B] mt-0.5 shrink-0" />
            <div>
              <div className="text-xs font-semibold text-[#1A1D24]">
                {dict.chat.unconfiguredTitle}
              </div>
              <p className="mt-0.5 text-xs text-[#4A4E58]">
                {dict.chat.unconfiguredDesc}
              </p>
            </div>
          </div>
          {user.role === "admin" && (
            <Button
              variant="outline"
              size="sm"
              onClick={onOpenAssistantSettings}
            >
              <Settings className="h-3.5 w-3.5" />
              {dict.chat.goToSettings}
            </Button>
          )}
        </div>
      )}

      {/* Conversation Feed */}
      <div className="flex-1 space-y-5 py-2">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center space-y-6">
            <div className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-[#ECC5BD] bg-[#FDF1EE] text-[#C85642]">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="grid w-full grid-cols-1 gap-2.5 sm:grid-cols-2 text-left">
              {dict.chat.starterIdeas.map((idea) => (
                <button
                  key={idea.label}
                  type="button"
                  disabled={!isAvailable || streaming}
                  onClick={() => void onSendMessage(idea.prompt, "chat")}
                  className="rounded-lg border border-[#E5E0D6] bg-[#FFFFFF] p-3.5 transition-colors hover:border-[#C85642] hover:bg-[#FDF1EE]/35 disabled:opacity-50"
                >
                  <div className="text-xs font-semibold text-[#1A1D24]">
                    {idea.label}
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] text-[#62666F]">
                    {idea.prompt}
                  </p>
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg) => {
            if (msg.role === "user") {
              return (
                <div key={msg.id} className="flex justify-end">
                  <div className="max-w-[82%] rounded-2xl rounded-br-sm border border-[#E5E0D6] bg-[#F2EFE9] px-4 py-2.5 text-[13px] leading-relaxed text-[#1A1D24] whitespace-pre-wrap">
                    {msg.content}
                  </div>
                </div>
              );
            }

            const segments = parseAssistantContent(msg.content);
            return (
              <div key={msg.id} className="space-y-3">
                <div className="rounded-lg border border-[#E5E0D6] bg-[#FFFFFF] p-4 space-y-3">
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
                          className="flex items-center gap-2 rounded-md border border-[#E5E0D6] bg-[#FAF8F4] px-3 py-2 text-xs text-[#62666F]"
                        >
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-[#C85642]" />
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
                    <div className="flex items-start gap-2 rounded-md border border-[#EBC1BC] bg-[#FDF0EE] px-3 py-2 text-xs text-[#B43B2E]">
                      <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                      <span>{msg.error}</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </div>

      {/* Composer */}
      <form
        onSubmit={handleSubmit}
        className="sticky bottom-4 rounded-lg border border-[#E5E0D6] bg-[#FFFFFF] p-3"
      >
        <div className="flex items-end gap-2">
          <Textarea
            rows={2}
            placeholder={dict.chat.placeholder}
            value={draft}
            disabled={!isAvailable}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            className="min-h-[54px] resize-none border-0 bg-transparent p-1 focus-visible:ring-0"
          />
          {streaming ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onStopStreaming}
              className="shrink-0"
            >
              <Square className="h-3.5 w-3.5" />
              {dict.chat.stop}
            </Button>
          ) : (
            <Button
              type="submit"
              size="sm"
              disabled={!isAvailable || !draft.trim()}
              className="shrink-0"
            >
              <Send className="h-3.5 w-3.5" />
              {dict.chat.send}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
