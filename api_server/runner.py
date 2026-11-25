"""In-process periodic runner: outbox draining + watch renewal + cleanup.

Started from the FastAPI lifespan when ``WEBHOOK_RUNNER_MODE="loop"`` and a
Pub/Sub topic is configured. Each tick drains due webhook deliveries; every
``_MAINTENANCE_EVERY_TICKS`` ticks it also renews near-expiry Gmail watches and
prunes old delivered rows. All work runs in worker threads so the event loop
stays responsive, and a tick failure can never kill the loop.

When ``WEBHOOK_RUNNER_MODE="endpoint"`` this loop stays dormant and the same
work is driven externally via ``POST /api/v1/google/internal/renew``.

``idempotency_sweep_lifespan`` is independent of the webhook runner: it prunes
expired ``idempotency_keys`` rows (and the cached responses they hold) once at
startup and then every ``_IDEMPOTENCY_SWEEP_INTERVAL_S``, whenever a database
is configured.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from loguru import logger as log

from api_server.idempotency import cleanup_expired_idempotency_keys
from common import global_config
from services.gmail_watch_svc import renew_due_watches
from services.webhook_delivery_svc import cleanup_delivered, drain_due_deliveries

# At the default 30s tick this runs maintenance roughly hourly.
_MAINTENANCE_EVERY_TICKS = 120
# Idempotency rows live for a day; a 15-minute sweep keeps the overshoot small.
_IDEMPOTENCY_SWEEP_INTERVAL_S = 15 * 60


async def _tick(counter: int) -> None:
    await asyncio.to_thread(drain_due_deliveries)
    if counter % _MAINTENANCE_EVERY_TICKS == 0:
        await asyncio.to_thread(renew_due_watches)
        await asyncio.to_thread(cleanup_delivered)


async def _run_loop() -> None:
    interval = max(5, global_config.WEBHOOK_RUNNER_INTERVAL_S)
    log.info("Webhook runner loop started (interval={}s)", interval)
    counter = 0
    while True:
        counter += 1
        try:
            await _tick(counter)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            # Loop resilience: a single tick's failure (DB blip, Gmail error)
            # must never terminate the runner - log and continue next tick.
            log.warning("Webhook runner tick failed: {}", exc)
        await asyncio.sleep(interval)


def runner_enabled() -> bool:
    return global_config.WEBHOOK_RUNNER_MODE == "loop" and bool(
        global_config.GMAIL_PUBSUB_TOPIC
    )


@asynccontextmanager
async def runner_lifespan(_app) -> AsyncIterator[None]:
    """Start the runner loop on enter, cancel it cleanly on shutdown."""
    task = asyncio.create_task(_run_loop()) if runner_enabled() else None
    try:
        yield
    finally:
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


async def _idempotency_sweep_loop() -> None:
    """Sweep expired idempotency rows now, then on a fixed interval."""
    while True:
        try:
            removed = await asyncio.to_thread(cleanup_expired_idempotency_keys)
            if removed:
                log.info("Pruned {} expired idempotency key(s)", removed)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            # Background maintenance: a DB blip must not kill the sweep loop;
            # log and try again next interval.
            log.warning("Idempotency key sweep failed: {}", exc)
        await asyncio.sleep(_IDEMPOTENCY_SWEEP_INTERVAL_S)


@asynccontextmanager
async def idempotency_sweep_lifespan(_app) -> AsyncIterator[None]:
    """Run the idempotency TTL sweep for the app's lifetime (DB required)."""
    enabled = bool(global_config.BACKEND_DB_URI)
    task = asyncio.create_task(_idempotency_sweep_loop()) if enabled else None
    try:
        yield
    finally:
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
