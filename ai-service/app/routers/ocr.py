"""
POST /ai/ocr

Preprocessing pipeline (in order):
  1. Fetch image bytes, EXIF-rotate, convert to BGR
  2. Greyscale
  3. Bilateral filter (d=9, sigmaColor=75, sigmaSpace=75)
  4. CLAHE (clipLimit=2.0, tileGridSize=(8,8))
  5. Deskew (Hough-line median angle)
  6. EasyOCR readtext(detail=1)
  7. Drop segments with conf < 0.4
  8. Return [{text, box: {x,y,w,h}, conf}]

EasyOCR (and its PyTorch dependency) is loaded via importlib on first call
so the service starts within the 512 MB Railway limit.
"""

from __future__ import annotations

import asyncio
import threading
from functools import partial
from typing import Any, Dict, List, Tuple

import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.dependencies import verify_token
from app.preprocessing import load_and_prepare

router = APIRouter(dependencies=[Depends(verify_token)])

# ── Lazy EasyOCR loader ───────────────────────────────────────────────────────
# importlib.import_module is used so no heavy top-level import statement appears
# in this file — startup memory stays well under 512 MB.

_reader_cache: Dict[Tuple[str, ...], Any] = {}
_cache_lock = threading.Lock()

_CONF_THRESHOLD = 0.25  # drop OCR segments below this confidence


def _get_reader(languages: Tuple[str, ...]) -> Any:
    import importlib
    with _cache_lock:
        if languages not in _reader_cache:
            print(f"[OCR] Loading EasyOCR for languages={languages} (first call)...")
            easyocr = importlib.import_module("easyocr")
            _reader_cache[languages] = easyocr.Reader(
                list(languages), gpu=False, verbose=False,
            )
            print("[OCR] EasyOCR ready.")
        return _reader_cache[languages]


# ── Schemas ───────────────────────────────────────────────────────────────────

class OcrRequest(BaseModel):
    image_url: str
    languages: List[str] = ["en"]


class BoundingBox(BaseModel):
    x: int
    y: int
    w: int
    h: int


class OcrSegment(BaseModel):
    text: str
    box:  BoundingBox
    conf: float


class OcrResponse(BaseModel):
    segments:       List[OcrSegment]
    full_text:      str
    avg_confidence: float
    language_hint:  List[str]


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.post("/ocr", response_model=OcrResponse)
async def run_ocr(req: OcrRequest) -> OcrResponse:
    print(f"[ENDPOINT HIT] /ai/ocr called")
    print(f"[IMAGE URL] {req.image_url[:80]}...")

    if not req.languages:
        raise HTTPException(status_code=422, detail="languages list must not be empty")

    try:
        img = await load_and_prepare(req.image_url)
    except Exception as exc:
        print(f"[OCR IMAGE LOAD ERROR] {exc}")
        raise HTTPException(
            status_code=400,
            detail={"error": "IMAGE_LOAD_FAILED", "code": "INVALID_IMAGE_URL"},
        )

    lang_key = tuple(req.languages)

    loop   = asyncio.get_running_loop()
    reader = await loop.run_in_executor(None, _get_reader, lang_key)

    try:
        results = await loop.run_in_executor(
            None,
            partial(reader.readtext, img.processed, detail=1, paragraph=False),
        )
    except Exception as exc:
        print(f"[EASYOCR ERROR] {exc}")
        raise HTTPException(status_code=500, detail={"error": str(exc), "code": "OCR_FAILED"})

    segments: List[OcrSegment] = []
    for bbox, text, conf in (results or []):
        if float(conf) < _CONF_THRESHOLD:
            continue
        pts = np.array(bbox, dtype=int)
        x   = int(pts[:, 0].min())
        y   = int(pts[:, 1].min())
        w   = int(pts[:, 0].max() - x)
        h   = int(pts[:, 1].max() - y)
        segments.append(
            OcrSegment(
                text=text,
                box=BoundingBox(x=x, y=y, w=w, h=h),
                conf=round(float(conf), 4),
            )
        )

    full_text = " ".join(s.text for s in segments)
    avg_conf  = (
        round(sum(s.conf for s in segments) / len(segments), 4)
        if segments else 0.0
    )

    print(
        f"[OCR] segments={len(segments)} avg_conf={avg_conf:.3f} "
        f"text_preview={full_text[:80]!r}"
    )
    return OcrResponse(
        segments=segments,
        full_text=full_text,
        avg_confidence=avg_conf,
        language_hint=req.languages,
    )
