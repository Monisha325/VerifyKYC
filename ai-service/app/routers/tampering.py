"""
POST /ai/tampering

Three-signal fraud/tampering detector for ID document images.

Signals:
  ELA           Error-Level Analysis — recompress at q=90, measure residual (0-100 scale)
  Copy-Move     ORB self-match — flag if >= 50 spatially-separated matching pairs
  EXIF Metadata Flag if editing software tag present or DateTime mismatch detected

Aggregate:
  fraud_score = min(100, ela_score*1.5 + 30*copy_move + 10*metadata_edited)
  verdict     = fraud_score > 60

Response:
  { ela_score, copy_move, metadata_edited, fraud_score, flags, verdict }
"""

from __future__ import annotations

import asyncio
import io
from typing import List

import cv2
import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from PIL import Image, ImageOps
from PIL.ExifTags import TAGS
from pydantic import BaseModel

from app.dependencies import verify_token
from app.preprocessing import fetch_image

router = APIRouter(dependencies=[Depends(verify_token)])


# ── Thresholds ────────────────────────────────────────────────────────────────

_ELA_QUALITY       = 90    # JPEG re-compression quality for ELA
_ELA_THRESHOLD     = 15.0  # ela_score (0-100) above this → ELA_SUSPICIOUS flag

_ORB_FEATURES      = 1000
_ORB_HAMMING_LIMIT = 40    # maximum Hamming distance to consider a match
_ORB_SPATIAL_MIN   = 50    # matched keypoints must be this many pixels apart
_CM_MIN_PAIRS      = 50    # flag copy-move when >= this many suspicious pairs

# ELA must be elevated for copy-move to count towards fraud_score.
# ID documents have repetitive text/borders that produce many ORB matches
# even when perfectly clean (ela_raw ≈ 0). Requiring ela_raw > this threshold
# prevents false positives on unmodified documents.
_ELA_MIN_FOR_CM    = 5.0

_FRAUD_VERDICT_THRESHOLD = 60.0

_EDIT_SOFTWARE = [
    "gimp", "photoshop", "paint.net", "affinity", "pixlr", "canva",
    "lightroom", "darktable", "rawtherapee", "snapseed", "facetune",
    "adobe", "corel", "inkscape", "krita",
]


# ── Schemas ───────────────────────────────────────────────────────────────────

class TamperingRequest(BaseModel):
    image_url: str


class TamperingRegion(BaseModel):
    x: int
    y: int
    w: int
    h: int
    source: str


class TamperingResponse(BaseModel):
    """Matches the core TypeScript ``TamperingResult`` interface."""
    ela_score:       float              # 0..1 normalised
    copy_move_score: float              # 0..1 normalised
    verdict:         str                # "clean" | "suspicious" | "tampered"
    regions:         List[TamperingRegion]


# ── ELA ───────────────────────────────────────────────────────────────────────

def _ela(pil_img: Image.Image) -> float:
    buf = io.BytesIO()
    pil_img.save(buf, format="JPEG", quality=_ELA_QUALITY)
    buf.seek(0)
    recompressed = Image.open(buf).convert("RGB")

    orig_arr   = np.array(pil_img,      dtype=np.float32)
    recomp_arr = np.array(recompressed, dtype=np.float32)

    diff = np.abs(orig_arr - recomp_arr)
    # Normalize mean pixel diff (0-255) → 0-100 scale
    return float(diff.mean()) / 255.0 * 100.0


# ── Copy-Move (ORB self-match) ────────────────────────────────────────────────

def _copy_move(pil_img: Image.Image) -> tuple[float, list[TamperingRegion]]:
    """Return (score 0..1, suspicious_regions)."""
    bgr  = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)

    orb         = cv2.ORB_create(_ORB_FEATURES)
    kps, descs  = orb.detectAndCompute(gray, None)

    if descs is None or len(descs) < 20:
        return 0.0, []

    bf      = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
    matches = bf.knnMatch(descs, descs, k=2)

    suspicious = 0
    regions: list[TamperingRegion] = []
    for pair in matches:
        if len(pair) < 2:
            continue
        m = pair[1]   # skip the self-match at pair[0]
        if m.trainIdx == m.queryIdx or m.distance > _ORB_HAMMING_LIMIT:
            continue
        p1 = kps[m.queryIdx].pt
        p2 = kps[m.trainIdx].pt
        dist = float(np.hypot(p1[0] - p2[0], p1[1] - p2[1]))
        if dist >= _ORB_SPATIAL_MIN:
            suspicious += 1
            regions.append(TamperingRegion(
                x=int(p2[0]) - 20, y=int(p2[1]) - 20,
                w=40, h=40, source="copy_move",
            ))

    score = min(1.0, suspicious / max(_CM_MIN_PAIRS, 1))
    return round(score, 4), regions


# ── EXIF Metadata ─────────────────────────────────────────────────────────────

def _metadata_edited(pil_img: Image.Image) -> bool:
    try:
        exif_data = pil_img._getexif()  # type: ignore[attr-defined]
    except Exception:
        exif_data = None

    if not exif_data:
        return False

    tag_map = {TAGS.get(k, k): v for k, v in exif_data.items()}

    # 1. Editing software in Software tag
    raw_sw = tag_map.get("Software")
    if raw_sw:
        sw = (
            raw_sw.decode("utf-8", errors="replace")
            if isinstance(raw_sw, bytes) else str(raw_sw)
        ).lower()
        if any(marker in sw for marker in _EDIT_SOFTWARE):
            return True

    # 2. Modification date differs from capture date
    dt_processed = tag_map.get("DateTime")
    dt_original  = tag_map.get("DateTimeOriginal")
    if dt_processed and dt_original and dt_processed != dt_original:
        return True

    return False


# ── Aggregate ─────────────────────────────────────────────────────────────────

def _analyse(img_bytes: bytes) -> TamperingResponse:
    pil_img = ImageOps.exif_transpose(Image.open(io.BytesIO(img_bytes))).convert("RGB")

    ela_raw                       = _ela(pil_img)           # 0-100 scale
    copy_move_score, cm_regions   = _copy_move(pil_img)     # 0..1, regions
    meta_edited                   = _metadata_edited(pil_img)

    # Normalise ELA to 0..1
    ela_score = round(min(1.0, ela_raw / 100.0), 4)

    # Determine verdict string.
    # Copy-move only contributes when ELA is also elevated — prevents false
    # positives from ORB matching repetitive text/border patterns on clean IDs.
    fraud_score_raw = min(
        100.0,
        ela_raw * 1.5
        + (30.0 if copy_move_score > 0.5 and ela_raw > _ELA_MIN_FOR_CM else 0.0)
        + (10.0 if meta_edited else 0.0),
    )
    if fraud_score_raw > _FRAUD_VERDICT_THRESHOLD:
        verdict = "tampered"
    elif fraud_score_raw > _FRAUD_VERDICT_THRESHOLD * 0.5:
        verdict = "suspicious"
    else:
        verdict = "clean"

    print(
        f"[TAMPERING] ela={ela_score:.4f} copy_move={copy_move_score:.4f} "
        f"meta={meta_edited} fraud_raw={fraud_score_raw:.2f} verdict={verdict}"
    )
    return TamperingResponse(
        ela_score=ela_score,
        copy_move_score=copy_move_score,
        verdict=verdict,
        regions=cm_regions,
    )


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.post("/tampering", response_model=TamperingResponse)
async def detect_tampering(req: TamperingRequest) -> TamperingResponse:
    print(f"[ENDPOINT HIT] /ai/tampering called")
    print(f"[IMAGE URL] {req.image_url[:80]}...")
    try:
        img_bytes = await fetch_image(req.image_url)
    except Exception as exc:
        print(f"[TAMPERING IMAGE LOAD ERROR] {exc}")
        raise HTTPException(
            status_code=400,
            detail={"error": "IMAGE_LOAD_FAILED", "code": "INVALID_IMAGE_URL"},
        )

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _analyse, img_bytes)
