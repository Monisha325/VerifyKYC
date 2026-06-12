"""
POST /ai/liveness/analyze

Accept base64 snapshots captured during client-side MediaPipe liveness checks,
run a lightweight OpenCV face-presence sanity check, and return a confidence score.

Liveness challenges (blink / smile / mouth open) are verified entirely in the
browser via MediaPipe FaceMesh — the server just confirms each snapshot contains
a real human face.
"""

from __future__ import annotations

import base64
import io
from typing import List

import cv2
import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from PIL import Image
from pydantic import BaseModel, Field
import asyncio
import logging
import time
from app.config import settings
from app.dependencies import verify_token

MAX_SNAPSHOTS = 5  # Limit snapshots per request
logger = logging.getLogger("liveness")
logger.setLevel(logging.INFO)
router = APIRouter(dependencies=[Depends(verify_token)])
# Load Haar cascade once — it's tiny (~400 KB) and fast
_FACE_CASCADE = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
)


class LivenessRequest(BaseModel):
    snapshots:  List[str] = Field(..., description="Base64-encoded JPEG snapshots (data-URI or raw base64)")
    challenges: List[str] = Field(default_factory=list, description="Challenge types that were completed")


class LivenessResponse(BaseModel):
    status:     str
    confidence: float
    faces_per_snapshot: List[int]
    message:    str
    processing_time_ms: int


def _b64_to_gray(data_url: str) -> np.ndarray | None:
    """Convert a base64 / data-URL image to a grayscale NumPy array."""
    try:
        raw = data_url.split(",", 1)[-1]  # strip data: prefix if present
        img_bytes = base64.b64decode(raw)
        pil = Image.open(io.BytesIO(img_bytes)).convert("L")
        return np.array(pil)
    except Exception:
        return None


def _count_faces(gray: np.ndarray) -> int:
    faces = _FACE_CASCADE.detectMultiScale(
        gray,
        scaleFactor=1.1,
        minNeighbors=4,
        minSize=(50, 50),
    )
    return len(faces) if len(faces) > 0 else 0  # type: ignore[arg-type]


@router.post("/liveness/analyze", response_model=LivenessResponse)
async def analyze_liveness(body: LivenessRequest) -> LivenessResponse:
    if not body.snapshots:
        raise HTTPException(status_code=400, detail="At least one snapshot is required")
    # Enforce a maximum number of snapshots to keep processing fast
    snapshots = body.snapshots[:MAX_SNAPSHOTS]
    start_time = time.time()

    async def process_snapshot(snap: str) -> int:
        gray = await asyncio.to_thread(_b64_to_gray, snap)
        if gray is None:
            logger.warning("Failed to decode a snapshot")
            return 0
        count = await asyncio.to_thread(_count_faces, gray)
        return count

    # Process snapshots concurrently to avoid blocking the event loop
    face_counts = await asyncio.gather(*(process_snapshot(s) for s in snapshots))

    snapshots_with_face = sum(1 for c in face_counts if c > 0)
    ratio = snapshots_with_face / len(face_counts) if face_counts else 0

    # Weight the confidence: all snapshots with a face → 95, none → 10
    base_confidence = 10 + ratio * 85

    # Bonus for completing all expected challenges
    expected_challenges = {"blink", "smile", "mouth_open"}
    completed = set(body.challenges)
    challenge_bonus = 5 if expected_challenges.issubset(completed) else 0
    confidence = min(base_confidence + challenge_bonus, 100)

    status = "verified" if ratio >= 0.4 else "failed"
    message = (
        "Liveness verified — face detected in snapshots."
        if status == "verified"
        else "Liveness check failed — could not confirm face presence."
    )

    processing_time_ms = int((time.time() - start_time) * 1000)
    return LivenessResponse(
        status=status,
        confidence=round(confidence, 2),
        faces_per_snapshot=face_counts,
        message=message,
        processing_time_ms=processing_time_ms,
    )
