"""
POST /ai/qr-exif

Checks two authenticity signals not covered by ELA/copy-move tampering:

1. QR code detection (OpenCV built-in QRCodeDetector — no extra deps)
   Aadhaar cards embed a QR code containing UID + demographic data.
   Absence where one is expected is a soft fraud signal.

2. EXIF metadata anomaly detection (PIL)
   Checks for editing-software markers (GIMP, Photoshop, Paint.NET …)
   and implausible capture timestamps — signals the image may have been
   manipulated before upload.

Input:  { "image_url": str }
Output: {
    "qr_found":      bool,
    "qr_count":      int,
    "qr_data":       list[str],         decoded QR payload strings
    "exif_flags":    list[str],         machine-readable anomaly codes
    "exif_software": str | null,        raw Software tag if present
    "exif_summary":  str                "clean" | "suspicious" | "no_exif"
}
"""

from __future__ import annotations

import asyncio
import io
from datetime import datetime, timezone
from typing import List, Optional

import cv2
import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from PIL import Image, ImageOps
from PIL.ExifTags import TAGS
from pydantic import BaseModel

from app.dependencies import verify_token
from app.preprocessing import fetch_image

router = APIRouter(dependencies=[Depends(verify_token)])

# ── Editing-software markers (case-insensitive substring match) ──────────────
_EDIT_SOFTWARE = [
    "gimp", "photoshop", "paint.net", "affinity", "pixlr", "canva",
    "lightroom", "darktable", "rawtherapee", "snapseed", "facetune",
    "adobe", "corel", "inkscape", "krita",
]

# Suspicious: image capture date is more than 10 years in the past or in the future
_TIMESTAMP_DRIFT_YEARS = 10


# ── Schemas ───────────────────────────────────────────────────────────────────

class QrExifRequest(BaseModel):
    image_url: str


class QrExifResponse(BaseModel):
    qr_found:      bool
    qr_count:      int
    qr_data:       List[str]
    exif_flags:    List[str]
    exif_software: Optional[str]
    exif_summary:  str


# ── QR detection ─────────────────────────────────────────────────────────────

def _detect_qr(bgr: np.ndarray) -> tuple[bool, int, List[str]]:
    detector = cv2.QRCodeDetector()
    # detectAndDecodeMulti returns (retval, decoded_list, points, straight_codes)
    try:
        retval, decoded, points, _ = detector.detectAndDecodeMulti(bgr)
    except Exception:
        retval, decoded, points = False, [], None

    if not retval or decoded is None:
        return False, 0, []

    # Filter out empty strings (detection without decode)
    payloads = [d for d in decoded if d]
    count = len(payloads) if payloads else (1 if retval else 0)
    return retval, count, payloads


# ── EXIF analysis ─────────────────────────────────────────────────────────────

def _analyse_exif(pil_img: Image.Image) -> tuple[List[str], Optional[str], str]:
    flags: List[str] = []
    software_tag: Optional[str] = None

    try:
        exif_data = pil_img._getexif()  # type: ignore[attr-defined]
    except Exception:
        exif_data = None

    if not exif_data:
        return [], None, "no_exif"

    tag_map = {TAGS.get(k, k): v for k, v in exif_data.items()}

    # 1. Software tag: check for known editing tools
    raw_software = tag_map.get("Software")
    if raw_software and isinstance(raw_software, (str, bytes)):
        sw = raw_software.decode("utf-8", errors="replace") if isinstance(raw_software, bytes) else raw_software
        software_tag = sw.strip()
        sw_lower = software_tag.lower()
        if any(marker in sw_lower for marker in _EDIT_SOFTWARE):
            flags.append("editing_software_detected")

    # 2. DateTime vs DateTimeOriginal mismatch
    dt_processed = tag_map.get("DateTime")
    dt_original  = tag_map.get("DateTimeOriginal")
    if dt_processed and dt_original and dt_processed != dt_original:
        flags.append("datetime_modified_after_capture")

    # 3. Implausible capture date (too old or in the future)
    capture_str = dt_original or dt_processed
    if capture_str and isinstance(capture_str, str):
        try:
            capture_dt = datetime.strptime(capture_str, "%Y:%m:%d %H:%M:%S")
            now = datetime.now()
            drift = abs((now - capture_dt).days / 365.25)
            if drift > _TIMESTAMP_DRIFT_YEARS:
                flags.append("implausible_capture_date")
        except ValueError:
            pass

    # 4. Missing GPS data is not suspicious for ID documents; present GPS is
    if tag_map.get("GPSInfo"):
        flags.append("gps_data_present")   # low-signal note, not a hard flag

    summary = "suspicious" if flags else "clean"
    return flags, software_tag, summary


# ── Endpoint ──────────────────────────────────────────────────────────────────

def _run_analysis(img_bytes: bytes) -> QrExifResponse:
    # Load once; share between QR and EXIF paths
    pil_img = ImageOps.exif_transpose(Image.open(io.BytesIO(img_bytes))).convert("RGB")
    bgr     = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)

    qr_found, qr_count, qr_data = _detect_qr(bgr)
    exif_flags, exif_software, exif_summary = _analyse_exif(pil_img)

    print(
        f"[QR-EXIF] qr_found={qr_found} qr_count={qr_count} "
        f"exif_flags={exif_flags} software={exif_software!r}"
    )
    return QrExifResponse(
        qr_found=qr_found,
        qr_count=qr_count,
        qr_data=qr_data,
        exif_flags=exif_flags,
        exif_software=exif_software,
        exif_summary=exif_summary,
    )


@router.post("/qr-exif", response_model=QrExifResponse)
async def check_qr_exif(req: QrExifRequest) -> QrExifResponse:
    print(f"[ENDPOINT HIT] /ai/qr-exif called")
    print(f"[IMAGE URL] {req.image_url[:80]}...")
    try:
        img_bytes = await fetch_image(req.image_url)
    except Exception as exc:
        print(f"[QR-EXIF IMAGE LOAD ERROR] {exc}")
        raise HTTPException(status_code=422, detail=f"Could not load image: {exc}")

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _run_analysis, img_bytes)
