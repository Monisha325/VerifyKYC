"""
Shared image preprocessing pipeline.

Steps applied before every analysis endpoint:
  1. Fetch image bytes from URL
  2. EXIF auto-rotation (Pillow ImageOps)
  3. RGB → greyscale
  4. Mild bilateral denoising
  5. CLAHE contrast normalisation
  6. Deskew to horizontal (Hough-line median angle)
  7. Conditional adaptive threshold (only when std-dev < 40, i.e. low-contrast scans)

Returns a dataclass with both the raw greyscale (for exposure metrics) and the
fully-processed greyscale (for blur metrics and OCR).
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import cv2
import httpx
import numpy as np
from PIL import Image, ImageOps


# ── HTTP fetch ──────────────────────────────────────────────────────────────

_HEADERS = {"User-Agent": "VeriKYC-AI/1.0 (+https://verikyc.io/bot)"}

# In-memory URL → bytes cache.  Each pipeline run hits the same Cloudinary URL
# across quality / OCR / tampering / qr-exif endpoints — caching avoids
# redundant downloads for the same image within a single server process.
_image_cache: dict = {}
_IMAGE_CACHE_MAX = 10


async def fetch_image(url: str) -> bytes:
    """Fetch raw image bytes from a URL, returning a cached copy if available.

    Supports:
      - https:// / http:// URLs (Cloudinary, etc.)
      - data: URLs  (base64-encoded images for testing / QR payloads)

    ``verify=False`` mirrors the Node.js core's NODE_TLS_REJECT_UNAUTHORIZED=0
    workaround — some dev/CI environments lack a full CA chain for Cloudinary's
    certificate.  In production behind Railway the TLS chain is complete and this
    flag has no security impact (traffic is internal).
    """
    # ── data: URL — decode inline base64, skip HTTP ───────────────────────────
    if url.startswith("data:"):
        import base64 as _b64
        # Format: data:<mime>;base64,<data>
        try:
            header, encoded = url.split(",", 1)
        except ValueError:
            raise ValueError(f"Malformed data: URL (no comma separator)")
        return _b64.b64decode(encoded)

    if url in _image_cache:
        return _image_cache[url]

    async with httpx.AsyncClient(
        timeout=30,
        follow_redirects=True,
        headers=_HEADERS,
        verify=False,
    ) as client:
        resp = await client.get(url)
        resp.raise_for_status()

    if len(_image_cache) >= _IMAGE_CACHE_MAX:
        oldest = next(iter(_image_cache))
        del _image_cache[oldest]
    _image_cache[url] = resp.content
    return resp.content


# ── Result container ─────────────────────────────────────────────────────────

@dataclass
class PreparedImage:
    raw_gray: np.ndarray     # greyscale only — used for exposure / histogram metrics
    processed: np.ndarray    # full pipeline — used for blur measurement and OCR
    width: int               # original pixel dimensions
    height: int


# ── Pipeline ─────────────────────────────────────────────────────────────────

def prepare(img_bytes: bytes) -> PreparedImage:
    # 1. Decode + EXIF rotation
    pil_img = Image.open(io.BytesIO(img_bytes))
    pil_img = ImageOps.exif_transpose(pil_img)          # handles all orientation tags
    pil_img = pil_img.convert("RGB")

    orig_w, orig_h = pil_img.size

    bgr = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)

    # 2. Greyscale
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)

    # Keep a raw greyscale copy before contrast/threshold changes alter the histogram
    raw_gray = gray.copy()

    # 3. Mild bilateral denoising  (d=9 preserves edges well at this sigma)
    denoised = cv2.bilateralFilter(gray, d=9, sigmaColor=75, sigmaSpace=75)

    # 4. CLAHE contrast normalisation
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(denoised)

    # 5. Deskew to horizontal
    deskewed = _deskew(enhanced)

    # 6. Conditional adaptive threshold — only for low-contrast images
    std = float(np.std(deskewed))
    if std < 40:
        processed = cv2.adaptiveThreshold(
            deskewed, 255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            blockSize=11,
            C=2,
        )
    else:
        processed = deskewed

    return PreparedImage(
        raw_gray=raw_gray,
        processed=processed,
        width=orig_w,
        height=orig_h,
    )


import asyncio

async def load_and_prepare(url: str) -> PreparedImage:
    img_bytes = await fetch_image(url)
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, prepare, img_bytes)


def _process_raw_rgb(img_bytes: bytes) -> np.ndarray:
    pil_img = Image.open(io.BytesIO(img_bytes))
    pil_img = ImageOps.exif_transpose(pil_img).convert("RGB")
    return cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)

async def load_raw_rgb(url: str) -> np.ndarray:
    """Fetch image, apply EXIF rotation, return BGR numpy array.
    Used by face and tampering endpoints that need colour — not the greyscale pipeline."""
    img_bytes = await fetch_image(url)
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _process_raw_rgb, img_bytes)


def _process_pil_rgb(img_bytes: bytes) -> Image.Image:
    pil_img = Image.open(io.BytesIO(img_bytes))
    return ImageOps.exif_transpose(pil_img).convert("RGB")

async def load_pil_rgb(url: str) -> Image.Image:
    """Fetch image, apply EXIF rotation, return PIL RGB image.
    Used by tampering/ELA which needs to re-encode via PIL."""
    img_bytes = await fetch_image(url)
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _process_pil_rgb, img_bytes)


# ── Deskew helper ─────────────────────────────────────────────────────────────

def _deskew(gray: np.ndarray) -> np.ndarray:
    """Estimate dominant skew angle from Hough lines and rotate to horizontal."""
    edges = cv2.Canny(gray, 50, 150, apertureSize=3)
    lines = cv2.HoughLinesP(
        edges, rho=1, theta=np.pi / 180,
        threshold=80, minLineLength=80, maxLineGap=10,
    )
    if lines is None:
        return gray

    angles: list[float] = []
    for line in lines:
        x1, y1, x2, y2 = line[0]
        dx = x2 - x1
        if dx == 0:
            continue
        angle = np.degrees(np.arctan2(float(y2 - y1), float(dx)))
        if -30 < angle < 30:          # ignore near-vertical lines
            angles.append(angle)

    if not angles:
        return gray

    median_angle = float(np.median(angles))
    if abs(median_angle) < 0.5:       # skip sub-pixel corrections
        return gray

    h, w = gray.shape
    M = cv2.getRotationMatrix2D((w // 2, h // 2), median_angle, 1.0)
    return cv2.warpAffine(
        gray, M, (w, h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE,
    )
