"""
POST /ai/quality

Four-gate image quality check for government ID documents.

Gates (all must pass):
  blur        Laplacian variance >= 8     (< 8 = blurry; per-type threshold used when doc_type present)
  resolution  width >= 100 AND height >= 100 px (per-type threshold used when doc_type present)
  exposure    <= 50% pixels > 250 (overexposed) AND <= 50% pixels < 5 (underexposed)
  crop        largest edge-contour covers > 10% of frame area

Response: { blur_score, blur_pass, glare_ratio, glare_pass, exposure, resolution, resolution_pass, overall_pass }
"""

from __future__ import annotations

from typing import Optional

import cv2
import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.dependencies import verify_token
from app.preprocessing import load_and_prepare

router = APIRouter(dependencies=[Depends(verify_token)])


# ── Thresholds ────────────────────────────────────────────────────────────────

_BLUR_MIN_VARIANCE  = 8.0     # Laplacian variance — below this = blurry (legacy, used as DEFAULT)
_MIN_DIMENSION_PX   = 100     # both width and height must meet this (legacy, used as DEFAULT)
_OVEREXPOSE_RATIO = {
    'AADHAAR': 0.50,
    'SELFIE':  0.92,  # webcam selfies can have large bright areas (windows, lamps)
    'DEFAULT': 0.80,
}  # per-type max fraction of pixels > 250 that triggers overexposure failure
_UNDEREXPOSE_RATIO = {
    'AADHAAR': 0.35,
    'SELFIE':  0.70,  # only fail if > 70% of image is near-black (truly unlit)
    'DEFAULT': 0.50,
}  # per-type max fraction of pixels < 5 that triggers underexposure failure
_CROP_MIN_COVERAGE  = 0.10    # document contour must cover > 10% of frame

# Per-document-type blur and resolution thresholds.
# Keyed by the doc_type string sent from the pipeline (Prisma DocKind values).
# 'DEFAULT' is used when doc_type is None or not found.
_BLUR_THRESHOLDS = {
    'AADHAAR':  15,
    'PAN':       8,
    'PASSPORT': 15,
    'DL':        8,
    'SELFIE':    8,  # bilateral denoising in preprocessing lowers variance; webcam needs lenient gate
    'DEFAULT':  10,
}
_RESOLUTION_THRESHOLDS = {
    'AADHAAR':  (200, 120),
    'PAN':      (100,  60),
    'PASSPORT': (100, 140),
    'DL':       (100,  60),
    'SELFIE':   (150, 150),
    'DEFAULT':  (100, 100),
}


# ── Schemas ───────────────────────────────────────────────────────────────────

class QualityRequest(BaseModel):
    image_url: str
    doc_type:  Optional[str] = None   # e.g. "AADHAAR", "PAN", "PASSPORT" — selects per-type thresholds


class QualityResponse(BaseModel):
    """Matches the core TypeScript ``QualityResult`` interface exactly."""
    blur_score:      float
    blur_pass:       bool
    glare_ratio:     float
    glare_pass:      bool
    exposure:        str          # "normal" | "overexposed" | "underexposed"
    resolution:      dict         # { width, height, megapixels }
    resolution_pass: bool
    overall_pass:    bool
    quality_score:   float        # 0.0-1.0 gradient score reflecting actual image quality


# ── Helpers ───────────────────────────────────────────────────────────────

def _check_crop(gray: np.ndarray) -> bool:
    """Document must fill more than 40% of the frame (edge-contour area check)."""
    edges = cv2.Canny(gray, 50, 150)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return False
    largest_area = float(max(cv2.contourArea(c) for c in contours))
    total_area   = float(gray.shape[0] * gray.shape[1])
    return (largest_area / total_area) > _CROP_MIN_COVERAGE


def _compute_glare_ratio(raw_gray: np.ndarray) -> float:
    """Fraction of pixels above 240 — a proxy for specular highlights / glare."""
    total = float(raw_gray.size)
    glare_px = float(np.sum(raw_gray > 240))
    return round(glare_px / total, 4) if total > 0 else 0.0


_GLARE_MAX_RATIO = {
    'AADHAAR': 0.35,
    'SELFIE':  0.88,  # bright indoor lighting makes many pixels > 240; use very lenient gate
    'DEFAULT': 0.70,
}  # per-type max bright-pixel fraction that triggers glare failure


# ── Endpoint ──────────────────────────────────────────────────────────────

@router.post("/quality", response_model=QualityResponse)
async def check_quality(req: QualityRequest) -> QualityResponse:
    print(f"[ENDPOINT HIT] /ai/quality called")
    print(f"[IMAGE URL] {req.image_url[:80]}...")

    try:
        img = await load_and_prepare(req.image_url)
    except Exception as exc:
        print(f"[QUALITY IMAGE LOAD ERROR] {exc}")
        raise HTTPException(
            status_code=400,
            detail={"error": "IMAGE_LOAD_FAILED", "code": "INVALID_IMAGE_URL"},
        )

    # Resolve per-type thresholds — falls back to DEFAULT when doc_type is absent or unknown
    doc_type       = req.doc_type
    blur_threshold = _BLUR_THRESHOLDS.get(doc_type or '', _BLUR_THRESHOLDS['DEFAULT'])
    min_w, min_h   = _RESOLUTION_THRESHOLDS.get(doc_type or '', _RESOLUTION_THRESHOLDS['DEFAULT'])

    # ── Blur ──────────────────────────────────────────────────────────────
    blur_score = float(cv2.Laplacian(img.processed, cv2.CV_64F).var())
    blur_pass  = blur_score >= blur_threshold
    print(f"[QUALITY] doc_type={doc_type} blur_threshold={blur_threshold} variance={blur_score:.1f}")

    # ── Glare ─────────────────────────────────────────────────────────────
    glare_ratio = _compute_glare_ratio(img.raw_gray)
    glare_limit = _GLARE_MAX_RATIO.get(doc_type, _GLARE_MAX_RATIO['DEFAULT'])
    glare_pass  = glare_ratio <= glare_limit

    # ── Resolution ────────────────────────────────────────────────────────
    resolution_pass = img.width >= min_w and img.height >= min_h
    megapixels      = round((img.width * img.height) / 1_000_000, 2)

    # ── Exposure (on raw_gray before CLAHE alters the histogram) ─────────
    total_px     = float(img.raw_gray.size)
    overexposed  = float(np.sum(img.raw_gray > 250)) / total_px
    underexposed = float(np.sum(img.raw_gray < 5))   / total_px

    print(f"[QUALITY] glare_ratio={glare_ratio:.3f} (max={_GLARE_MAX_RATIO}) "
          f"overexposed_ratio={overexposed:.3f} (max={_OVEREXPOSE_RATIO}) "
          f"underexposed_ratio={underexposed:.3f} (max={_UNDEREXPOSE_RATIO})")

    over_limit  = _OVEREXPOSE_RATIO.get(doc_type, _OVEREXPOSE_RATIO['DEFAULT'])
    under_limit = _UNDEREXPOSE_RATIO.get(doc_type, _UNDEREXPOSE_RATIO['DEFAULT'])

    if overexposed > over_limit:
        exposure = "overexposed"
    elif underexposed > under_limit:
        exposure = "underexposed"
    else:
        exposure = "normal"

    overall_pass = blur_pass and glare_pass and resolution_pass and exposure == "normal"

    print(
        f"[QUALITY] {img.width}×{img.height} blur={blur_score:.1f} "
        f"glare={glare_ratio:.4f} exposure={exposure} overall={overall_pass}"
    )

    # ── Gradient quality score (0.0-1.0) ──────────────────────────────────
    # Reflects how comfortably each gate was cleared rather than a binary
    # pass/fail, so downstream confidence scoring can scale proportionally.
    blur_gradient = min(1.0, blur_score / (blur_threshold * 1.5)) if blur_score > 0 else 0.0

    glare_gradient = max(0.0, 1.0 - (glare_ratio / glare_limit)) if glare_pass else 0.0

    exposure_pass     = exposure == "normal"
    exposure_gradient = max(0.0, 1.0 - max(
        overexposed / over_limit,
        underexposed / under_limit,
    )) if exposure_pass else 0.0

    quality_score = round(
        0.50 * blur_gradient +
        0.30 * glare_gradient +
        0.20 * exposure_gradient,
        4,
    )

    # ── Selfie override — brightness + std_dev only; ignore blur/glare/resolution ──
    # Webcam frames are preprocessed (bilateral denoising) and have no EXIF.
    # Face match is the authoritative quality gate; this score is a minor signal.
    if doc_type == 'SELFIE':
        brightness = float(np.mean(img.raw_gray))
        std_dev    = float(np.std(img.raw_gray))
        print(f"[quality-selfie] brightness={brightness:.1f} std_dev={std_dev:.2f}")
        qs = 1.0
        if brightness < 30 or brightness > 240:
            qs -= 0.20
        if std_dev < 10:
            qs -= 0.20
        quality_score = round(max(0.0, qs), 4)
        # Only hard-fail selfies on truly blank/near-black images
        overall_pass  = std_dev >= 5.0

    return QualityResponse(
        blur_score=round(blur_score, 2),
        blur_pass=blur_pass,
        glare_ratio=glare_ratio,
        glare_pass=glare_pass,
        exposure=exposure,
        resolution={"width": img.width, "height": img.height, "megapixels": megapixels},
        resolution_pass=resolution_pass,
        overall_pass=overall_pass,
        quality_score=quality_score,
    )
