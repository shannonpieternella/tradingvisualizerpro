"""Cron scheduler for autonomous trading chart monitoring."""
import asyncio
import json
import logging
import uuid
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

import pytz
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

logger = logging.getLogger(__name__)

EASTERN = pytz.timezone("America/New_York")


class TradingScheduler:
    def __init__(
        self,
        jobs_file: str,
        broadcast_fn: Callable,
        get_agent_fn: Callable,
    ):
        self.jobs_file = Path(jobs_file)
        self.jobs_file.parent.mkdir(parents=True, exist_ok=True)
        self.broadcast = broadcast_fn
        self.get_agent = get_agent_fn  # factory that returns a fresh ClaudeAgent
        self.scheduler = AsyncIOScheduler(timezone=EASTERN)
        self._jobs: dict = {}  # id -> job dict

    def start(self):
        self._load_jobs()
        self.scheduler.start()
        logger.info("Scheduler started with %d jobs", len(self._jobs))

    def stop(self):
        self.scheduler.shutdown(wait=False)

    # ── Job management ─────────────────────────────────────────────────────

    def add_job(self, job: dict) -> dict:
        job.setdefault("id", str(uuid.uuid4())[:8])
        job.setdefault("active", True)
        job.setdefault("created_at", datetime.now(EASTERN).isoformat())
        job.setdefault("last_run", None)
        job.setdefault("run_count", 0)

        self._jobs[job["id"]] = job
        if job["active"]:
            self._schedule(job)
        self._save_jobs()
        logger.info("Added job: %s (%s)", job["name"], job["id"])
        return job

    def remove_job(self, job_id: str) -> bool:
        if job_id not in self._jobs:
            return False
        self._unschedule(job_id)
        del self._jobs[job_id]
        self._save_jobs()
        return True

    def toggle_job(self, job_id: str) -> Optional[dict]:
        job = self._jobs.get(job_id)
        if not job:
            return None
        job["active"] = not job["active"]
        if job["active"]:
            self._schedule(job)
        else:
            self._unschedule(job_id)
        self._save_jobs()
        return job

    def list_jobs(self) -> list[dict]:
        return list(self._jobs.values())

    def run_now(self, job_id: str):
        job = self._jobs.get(job_id)
        if job:
            asyncio.create_task(self._execute_job(job))

    # ── Internal ───────────────────────────────────────────────────────────

    def _schedule(self, job: dict):
        self._unschedule(job["id"])
        if job.get("type") == "cron":
            trigger = CronTrigger.from_crontab(job["cron"], timezone=EASTERN)
        else:  # interval
            trigger = IntervalTrigger(minutes=job.get("interval_minutes", 15))
        self.scheduler.add_job(
            self._execute_job,
            trigger=trigger,
            id=job["id"],
            args=[job],
            replace_existing=True,
            misfire_grace_time=60,
        )

    def _unschedule(self, job_id: str):
        try:
            self.scheduler.remove_job(job_id)
        except Exception:
            pass

    async def _execute_job(self, job: dict):
        logger.info("Running cron job: %s", job["name"])
        self._jobs[job["id"]]["last_run"] = datetime.now(EASTERN).isoformat()
        self._jobs[job["id"]]["run_count"] = job.get("run_count", 0) + 1
        self._save_jobs()

        await self.broadcast({
            "type": "cron_running",
            "job_id": job["id"],
            "job_name": job["name"],
        })

        try:
            agent = self.get_agent()  # fresh isolated agent
            result_parts = []
            async for chunk in agent.process(job["message"]):
                if chunk["type"] == "text":
                    result_parts.append(chunk["content"])
                elif chunk["type"] == "screenshot":
                    await self.broadcast({
                        "type": "cron_screenshot",
                        "job_name": job["name"],
                        "data": chunk["data"],
                    })

            result = "".join(result_parts).strip()
            if result:
                await self.broadcast({
                    "type": "cron_alert",
                    "job_id": job["id"],
                    "job_name": job["name"],
                    "content": result,
                    "timestamp": datetime.now(EASTERN).strftime("%H:%M ET"),
                })
                logger.info("Cron job result [%s]: %s", job["name"], result[:100])
            else:
                logger.info("Cron job [%s]: no output", job["name"])

        except Exception as e:
            logger.error("Cron job error [%s]: %s", job["name"], e)
            await self.broadcast({
                "type": "cron_error",
                "job_name": job["name"],
                "content": str(e),
            })

    def _load_jobs(self):
        if self.jobs_file.exists():
            data = json.loads(self.jobs_file.read_text())
            for job in data.get("jobs", []):
                self._jobs[job["id"]] = job
                if job.get("active", True):
                    try:
                        self._schedule(job)
                    except Exception as e:
                        logger.error("Failed to schedule job %s: %s", job["id"], e)

    def _save_jobs(self):
        self.jobs_file.write_text(
            json.dumps({"jobs": list(self._jobs.values())}, indent=2, default=str)
        )
