import { useEffect, useRef, useState } from "react";
import type {
  ImageCreatedEvent,
  ImageUploadedEvent,
  ImageUploadFailedEvent,
  JobUpdatedEvent,
  PoolGpuUnavailableEvent,
  PoolUpdatedEvent,
  SseConnectionState,
  WorkerUpdatedEvent,
} from "@/types/api";

export interface SseHandlers {
  onJobUpdated?: (ev: JobUpdatedEvent) => void;
  onWorkerUpdated?: (ev: WorkerUpdatedEvent) => void;
  onPoolUpdated?: (ev: PoolUpdatedEvent) => void;
  onPoolGpuUnavailable?: (ev: PoolGpuUnavailableEvent) => void;
  onImageCreated?: (ev: ImageCreatedEvent) => void;
  onImageUploaded?: (ev: ImageUploadedEvent) => void;
  onImageUploadFailed?: (ev: ImageUploadFailedEvent) => void;
  onUnauthorized?: () => void;
}

const EVENT_NAMES = [
  "job.updated",
  "worker.updated",
  "pool.updated",
  "pool.gpu_unavailable",
  "image.created",
  "image.uploaded",
  "image.upload_failed",
] as const;

export function useEventStream(
  enabled: boolean,
  handlers: SseHandlers
): { state: SseConnectionState; reconnect: () => void } {
  const [state, setState] = useState<SseConnectionState>(
    enabled ? "connecting" : "offline"
  );
  const [nonce, setNonce] = useState(0);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) {
      setState("offline");
      return;
    }

    let disposed = false;
    let source: EventSource | null = null;
    let retryTimer: number | null = null;
    let attempt = 0;

    const clearTimer = () => {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const connect = () => {
      if (disposed) return;
      setState(attempt === 0 ? "connecting" : "reconnecting");

      const es = new EventSource("/api/events", { withCredentials: true });
      source = es;

      es.onopen = () => {
        if (disposed) return;
        attempt = 0;
        setState("live");
      };

      const dispatch = (eventName: (typeof EVENT_NAMES)[number], raw: string) => {
        if (disposed) return;
        let data: unknown;
        try {
          data = JSON.parse(raw);
        } catch {
          return;
        }
        const h = handlersRef.current;
        switch (eventName) {
          case "job.updated":
            h.onJobUpdated?.(data as JobUpdatedEvent);
            break;
          case "worker.updated":
            h.onWorkerUpdated?.(data as WorkerUpdatedEvent);
            break;
          case "pool.updated":
            h.onPoolUpdated?.(data as PoolUpdatedEvent);
            break;
          case "pool.gpu_unavailable":
            h.onPoolGpuUnavailable?.(data as PoolGpuUnavailableEvent);
            break;
          case "image.created":
            h.onImageCreated?.(data as ImageCreatedEvent);
            break;
          case "image.uploaded":
            h.onImageUploaded?.(data as ImageUploadedEvent);
            break;
          case "image.upload_failed":
            h.onImageUploadFailed?.(data as ImageUploadFailedEvent);
            break;
        }
      };

      for (const name of EVENT_NAMES) {
        es.addEventListener(name, (e) => {
          dispatch(name, (e as MessageEvent<string>).data);
        });
      }

      es.onerror = async () => {
        if (disposed) return;
        // If EventSource closed permanently (e.g. 401 or server closed), check auth and schedule reconnect
        if (es.readyState === EventSource.CLOSED) {
          es.close();
          source = null;
          try {
            const probe = await fetch("/api/auth/me", { credentials: "same-origin" });
            if (probe.status === 401) {
              setState("offline");
              handlersRef.current.onUnauthorized?.();
              return;
            }
          } catch {
            // Network down; fall through to reconnect
          }
          attempt += 1;
          const delayMs = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 4));
          setState("reconnecting");
          clearTimer();
          retryTimer = window.setTimeout(connect, delayMs);
        } else {
          // Browser EventSource is automatically retrying with Last-Event-ID
          setState("reconnecting");
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      clearTimer();
      if (source) {
        source.close();
        source = null;
      }
    };
  }, [enabled, nonce]);

  return {
    state,
    reconnect: () => setNonce((n) => n + 1),
  };
}
