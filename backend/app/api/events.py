"""In-memory SSE event bus with ring-buffer replay and heartbeat support."""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections import deque
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import StreamingResponse

from app.auth.deps import get_current_user, get_settings
from app.auth.service import UserRecord
from app.config import Settings

router = APIRouter(tags=["events"])


@dataclass(frozen=True)
class BusEvent:
    id: int
    event_type: str
    data: dict[str, Any]
    user_id: str | None

    def format_sse(self) -> str:
        payload = json.dumps(self.data, separators=(",", ":"))
        return f"id: {self.id}\nevent: {self.event_type}\ndata: {payload}\n\n"

    def visible_to(self, user: UserRecord) -> bool:
        return self.user_id is None or user.is_admin or self.user_id == user.id


@dataclass(eq=False)
class _Subscriber:
    user: UserRecord
    queue: asyncio.Queue[BusEvent | None]


class EventBus:
    """Async pub-sub event bus with Last-Event-ID replay."""

    def __init__(self, maxlen: int = 500) -> None:
        self._buffer: deque[BusEvent] = deque(maxlen=maxlen)
        self._next_id = 1
        self._subscribers: set[_Subscriber] = set()
        self._lock = asyncio.Lock()
        self._closed = False

    async def close(self) -> None:
        async with self._lock:
            self._closed = True
            for sub in list(self._subscribers):
                with contextlib.suppress(asyncio.QueueFull):
                    sub.queue.put_nowait(None)

    async def publish(
        self,
        event_type: str,
        data: dict[str, Any],
        *,
        user_id: str | None = None,
    ) -> int:
        async with self._lock:
            event = BusEvent(
                id=self._next_id,
                event_type=event_type,
                data=data,
                user_id=user_id,
            )
            self._next_id += 1
            self._buffer.append(event)
            for sub in list(self._subscribers):
                if event.visible_to(sub.user):
                    if sub.queue.full():
                        with contextlib.suppress(asyncio.QueueEmpty):
                            sub.queue.get_nowait()
                    sub.queue.put_nowait(event)
            return event.id

    async def subscribe(
        self,
        user: UserRecord,
        *,
        last_event_id: int | None = None,
        heartbeat_seconds: float = 20.0,
        max_events: int | None = None,
    ) -> AsyncIterator[str]:
        sub = _Subscriber(user=user, queue=asyncio.Queue(maxsize=200))
        async with self._lock:
            replay = [
                ev
                for ev in self._buffer
                if (last_event_id is None or ev.id > last_event_id) and ev.visible_to(user)
            ]
            self._subscribers.add(sub)

        sent = 0
        try:
            # Only replay if Last-Event-ID was provided so fresh clients don't get flooded
            if last_event_id is not None:
                for ev in replay:
                    yield ev.format_sse()
                    sent += 1
                    if max_events is not None and sent >= max_events:
                        return

            while not self._closed:
                try:
                    ev = await asyncio.wait_for(sub.queue.get(), timeout=heartbeat_seconds)
                    if ev is None:
                        return
                    yield ev.format_sse()
                    sent += 1
                    if max_events is not None and sent >= max_events:
                        return
                except TimeoutError:
                    yield ": ping\n\n"
        finally:
            async with self._lock:
                self._subscribers.discard(sub)


def _parse_last_event_id(raw: str | None) -> int | None:
    if not raw:
        return None
    try:
        return int(raw.strip())
    except ValueError:
        return None


@router.get("/api/events")
async def stream_events(
    request: Request,
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
    user: UserRecord = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> StreamingResponse:
    events: EventBus = request.app.state.events
    parsed_id = _parse_last_event_id(last_event_id)

    async def _gen() -> AsyncIterator[str]:
        if parsed_id is None:
            yield ": connected\n\n"
        async for chunk in events.subscribe(
            user,
            last_event_id=parsed_id,
            heartbeat_seconds=settings.sse_heartbeat_seconds,
        ):
            if await request.is_disconnected():
                break
            yield chunk

    return StreamingResponse(
        _gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
