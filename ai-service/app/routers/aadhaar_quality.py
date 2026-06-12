"""
POST /ai/quality/aadhaar

Enhanced Aadhaar-specific image quality validator.

Implements full document-type-aware, zone-based quality checking:
  1. Image loading + format detection (JPG / PNG / PDF via PyMuPDF if available)
  2. Document type detection  (TYPE 1A – TYPE 6)
  3. Front card isolation + perspective / orientation correction
  4. Card variant detection   (full vs masked)
  5. Watermark detection
  6. Zone-based quality checks (top / middle / bottom with variant-specific thresholds)
  7. Quality score computation (gradients + penalty model)

Output is strict JSON matching the AadhaarQualityResponse schema.
overall_pass = false only on hard-fail conditions; all other problems are
WARN + penalty so downstream OCR can still proceed.
"""

from __future__ import annotations

import io
import math
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from PIL import Image, ImageOps
from pydantic import BaseModel

from app.dependencies import verify_token
from app.preprocessing import fetch_image

router = APIRouter(dependencies=[Depends(verify_token)])

# ── Optional PDF support (PyMuPDF) ────────────────────────────────────────────
try:
    import fitz as _fitz
    _PDF_OK = True
except ImportError:
    _fitz  = None   # type: ignore[assignment]
    _PDF_OK = False

# ── Thresholds ────────────────────────────────────────────────────────────────

_GLOBAL_BLUR_FAIL    = 15.0
_GLOBAL_BLUR_FAIL_PC = 12.0        # photocopy-adjusted

_BOT_BLUR_FAIL = {"full": 20.0, "masked": 15.0, "unknown": 20.0}
_BOT_BLUR_FAIL_PC = {"full": 16.0, "masked": 12.0, "unknown": 16.0}

_TOP_BLUR_WARN    = 20.0
_TOP_BLUR_WARN_PC = 16.0

_MID_BLUR_WARN_FULL      = 15.0
_MID_BLUR_WARN_MASKED    = 10.0
_MID_BLUR_WARN_PC_FULL   = 12.0   # photocopy + full
_MID_BLUR_WARN_PC_MASKED =  8.0   # photocopy + masked (greyscale naturally lower)

_RES_FAIL_W, _RES_FAIL_H = 300, 190
_RES_WARN_W, _RES_WARN_H = 400, 250

_AR_MIN_FULL   = 1.30
_AR_MIN_MASKED = 1.20
_AR_MAX        = 1.90

_OVEREXPOSE_FAIL,  _OVEREXPOSE_WARN     = 70.0, 55.0
_UNDEREXPOSE_FAIL, _UNDEREXPOSE_WARN    = 60.0, 40.0
_OVEREXPOSE_FAIL_PC,  _OVEREXPOSE_WARN_PC  = 80.0, 65.0   # photocopy looser warn
_UNDEREXPOSE_FAIL_PC, _UNDEREXPOSE_WARN_PC = 70.0, 55.0   # photocopy looser warn

_GLARE_WARN                = 25.0
_GLARE_BOT_FAIL_FULL       = 50.0
_GLARE_BOT_FAIL_MASKED     = 45.0

_QUALITY_TIERS = [
    (0.85, "excellent"),
    (0.70, "good"),
    (0.50, "acceptable"),
    (0.30, "poor"),
    (0.00, "reject"),
]

# ── Schemas ───────────────────────────────────────────────────────────────────

class AadhaarQualityRequest(BaseModel):
    image_url: str


class AadhaarQualityResponse(BaseModel):
    overall_pass:             bool
    quality_tier:             str
    quality_score:            float
    quality_gate_multiplier:  float
    source_format:            str
    document_type:            str
    card_variant:             str
    card_detected:            bool
    dual_side_detected:       bool
    watermark_detected:       bool
    photocopy_detected:       bool
    scanned_copy_detected:    bool
    ui_chrome_removed:        bool
    perspective_corrected:    bool
    orientation_corrected:    bool
    zone_thresholds_adjusted: bool
    manual_review_required:   bool
    isolated_card_dimensions: Dict[str, int]
    zone_boundaries_used:     Dict[str, int]
    checks:                   Dict[str, Any]
    warnings:                 List[Dict[str, Any]]
    fail_reasons:             List[Dict[str, Any]]
    gradients:                Dict[str, float]
    penalties_applied:        List[Dict[str, Any]]
    total_penalty:            float
    base_score:               float


# ── Image loading ─────────────────────────────────────────────────────────────

def _detect_format(data: bytes) -> str:
    if data[:4] == b"%PDF":
        return "pdf"
    if data[:2] in (b"\xff\xd8", b"\xff\xe0", b"\xff\xe1"):
        return "jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    return "jpg"   # best-effort fallback


def _decode(data: bytes, fmt: str) -> Tuple[np.ndarray, Image.Image]:
    if fmt == "pdf":
        if not _PDF_OK:
            raise ValueError("PDF support requires PyMuPDF — install pymupdf")
        doc  = _fitz.open(stream=data, filetype="pdf")
        page = doc[0]
        mat  = _fitz.Matrix(150 / 72, 150 / 72)   # 150 DPI minimum
        pix  = page.get_pixmap(matrix=mat, colorspace=_fitz.csRGB)
        data = pix.tobytes("png")
        fmt  = "png"

    pil = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
    bgr = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
    return bgr, pil


# ── Photocopy / scan heuristics ───────────────────────────────────────────────

def _is_photocopy(bgr: np.ndarray) -> bool:
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    avg_sat = float(hsv[:, :, 1].mean())
    gray    = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    contrast = float(gray.std())
    return avg_sat < 15 and contrast < 40


def _is_scanned(bgr: np.ndarray, photocopy: bool) -> bool:
    if photocopy:
        return False
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    bs = max(min(h, w) // 6, 10)
    means = [
        float(gray[r:r + bs, c:c + bs].mean())
        for r in range(0, h - bs, bs)
        for c in range(0, w - bs, bs)
    ]
    return len(means) >= 4 and float(np.std(means)) < 12


# ── Document type detection ───────────────────────────────────────────────────

def _card_contours(bgr: np.ndarray) -> List[np.ndarray]:
    gray  = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    blur  = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blur, 50, 150)
    k     = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    edges = cv2.dilate(edges, k, iterations=1)
    cnts, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    img_area = float(bgr.shape[0] * bgr.shape[1])
    out = []
    for c in cnts:
        if cv2.contourArea(c) < img_area * 0.03:
            continue
        x, y, w, h = cv2.boundingRect(c)
        ar = w / h if h > 0 else 0
        if 1.1 <= ar <= 2.2:
            out.append(c)
    out.sort(key=cv2.contourArea, reverse=True)
    return out


def _detect_doc_type(
    bgr: np.ndarray,
    photocopy: bool,
    scanned: bool,
) -> Tuple[str, Dict[str, Any]]:
    h, w = bgr.shape[:2]
    aspect = w / h if h > 0 else 1.0
    meta: Dict[str, Any] = {"full_image_aspect": round(aspect, 3)}

    # UI chrome check (dark bars top & bottom — mAadhaar / screenshot)
    top_bar_mean    = float(cv2.cvtColor(bgr[:max(1, int(h * 0.08)), :],  cv2.COLOR_BGR2GRAY).mean())
    bottom_bar_mean = float(cv2.cvtColor(bgr[int(h * 0.92):, :], cv2.COLOR_BGR2GRAY).mean())
    if top_bar_mean < 45 and bottom_bar_mean < 45:
        meta["ui_chrome"] = True
        return "type4a_maadhar_screenshot", meta

    if photocopy:
        meta["photocopy"] = True
        return "type5b_photocopy", meta

    if scanned:
        meta["scanned"] = True
        return "type5a_scanned", meta

    # TYPE 2A — PVC vertical (both sides, stacked)
    if h > w * 1.2:
        if len(_card_contours(bgr)) >= 2:
            meta["dual_side"] = True
            meta["split"]     = "vertical"
            return "type2a_pvc_vertical", meta

    # TYPE 2B — PVC horizontal (both sides, side by side)
    if w > h * 2.5:
        if len(_card_contours(bgr)) >= 2:
            meta["dual_side"] = True
            meta["split"]     = "horizontal"
            return "type2b_pvc_horizontal", meta

    # TYPE 1A / TYPE 1B — portrait page proportions (A4 ≈ 0.707, letters 0.55–0.78)
    # Distinguish by whether TWO card regions exist in the bottom half (DigiLocker
    # embeds front + back side by side in the bottom half).  One card = TYPE 1B.
    if 0.55 <= aspect <= 0.78:
        bottom_half  = bgr[h // 2:, :]
        bottom_cards = _card_contours(bottom_half)
        if len(bottom_cards) >= 2:
            # DigiLocker / e-Aadhaar A4 — two cards in bottom half
            meta["dual_side"] = True
            meta["a4_format"] = True
            return "type1a_eaadhaar_a4", meta
        # Pre-2017 letter or any portrait page with a single embedded card
        meta["letter_format"] = True
        return "type1b_letter", meta

    return "type3_single_front", meta


# ── Back-side detection ───────────────────────────────────────────────────────

def _is_back_side(bgr: np.ndarray) -> bool:
    """
    Heuristic: front side has a face-photo (high local variance) in the
    top-left area; back side has a QR code (very high variance) in the
    bottom-right and a featureless address block at top.
    Conservative — only flags with high confidence.
    """
    h, w = bgr.shape[:2]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)

    tl  = gray[:h // 2,  :w // 3]       # photo zone on front
    br  = gray[h // 2:, 2 * w // 3:]    # QR code zone on back

    tl_var = float(cv2.Laplacian(tl, cv2.CV_64F).var()) if tl.size > 0 else 999.0
    br_var = float(cv2.Laplacian(br, cv2.CV_64F).var()) if br.size > 0 else 0.0

    return tl_var < 15 and br_var > 300


# ── Card quad detection + perspective transform ───────────────────────────────

def _order_pts(pts: np.ndarray) -> np.ndarray:
    rect = np.zeros((4, 2), dtype="float32")
    s    = pts.sum(axis=1)
    d    = np.diff(pts, axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    rect[1] = pts[np.argmin(d)]
    rect[3] = pts[np.argmax(d)]
    return rect


def _warp(bgr: np.ndarray, pts: np.ndarray) -> np.ndarray:
    rect = _order_pts(pts)
    tl, tr, br, bl = rect
    max_w = int(max(np.linalg.norm(br - bl), np.linalg.norm(tr - tl)))
    max_h = int(max(np.linalg.norm(tr - br), np.linalg.norm(tl - bl)))
    if max_w <= 0 or max_h <= 0:
        return bgr
    dst = np.array([[0, 0], [max_w - 1, 0], [max_w - 1, max_h - 1], [0, max_h - 1]], dtype="float32")
    M   = cv2.getPerspectiveTransform(rect, dst)
    return cv2.warpPerspective(bgr, M, (max_w, max_h))


def _find_quad(bgr: np.ndarray) -> Optional[np.ndarray]:
    gray  = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    blur  = cv2.GaussianBlur(gray, (7, 7), 0)
    edges = cv2.Canny(blur, 30, 120)
    k     = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))
    edges = cv2.dilate(edges, k, iterations=2)

    cnts, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    img_area = float(bgr.shape[0] * bgr.shape[1])

    for cnt in sorted(cnts, key=cv2.contourArea, reverse=True):
        if cv2.contourArea(cnt) < img_area * 0.05:
            break
        peri = cv2.arcLength(cnt, True)
        for eps in [0.02, 0.03, 0.04, 0.05]:
            approx = cv2.approxPolyDP(cnt, eps * peri, True)
            if len(approx) != 4:
                continue
            pts  = approx.reshape(4, 2).astype("float32")
            rect = _order_pts(pts)
            cw   = max(np.linalg.norm(rect[1] - rect[0]), np.linalg.norm(rect[2] - rect[3]))
            ch   = max(np.linalg.norm(rect[3] - rect[0]), np.linalg.norm(rect[2] - rect[1]))
            if ch <= 0:
                continue
            if 1.1 <= cw / ch <= 2.2:
                return pts
    return None


def _fix_orientation(bgr: np.ndarray) -> Tuple[np.ndarray, bool]:
    h, w = bgr.shape[:2]
    ar = w / h if h > 0 else 1.0
    if ar < 0.70:   # portrait — rotated 90°
        return cv2.rotate(bgr, cv2.ROTATE_90_CLOCKWISE), True
    return bgr, False


def _isolate_card(
    bgr: np.ndarray,
    doc_type: str,
    meta: Dict[str, Any],
) -> Tuple[np.ndarray, bool, bool, bool]:
    """Returns (card, perspective_corrected, orientation_corrected, chrome_removed)."""
    h, w = bgr.shape[:2]
    persp, orient, chrome = False, False, False

    # ── Type-specific pre-crop ────────────────────────────────────────────────
    if doc_type == "type1a_eaadhaar_a4":
        region = bgr[h // 2:, :w // 2]
    elif doc_type == "type1b_letter":
        region = bgr[int(h * 0.35):, :]
    elif doc_type == "type2a_pvc_vertical":
        region = bgr[:h // 2, :]
    elif doc_type == "type2b_pvc_horizontal":
        region = bgr[:, :w // 2]
    elif doc_type in ("type4a_maadhar_screenshot", "type4b_pdf_screenshot"):
        top    = int(h * 0.08)
        bot    = int(h * 0.92)
        region = bgr[top:bot, :]
        chrome = True
    else:
        region = bgr

    # ── Quad detection + perspective warp ────────────────────────────────────
    quad = _find_quad(region)
    if quad is not None:
        card  = _warp(region, quad)
        persp = True
    else:
        card = region

    # ── Orientation correction ────────────────────────────────────────────────
    card, corrected = _fix_orientation(card)
    if corrected:
        orient = True

    return card, persp, orient, chrome


# ── Card variant ──────────────────────────────────────────────────────────────

def _detect_vid_band(bot_zone: np.ndarray) -> bool:
    """
    Signal 2: VID number present → masked Aadhaar.
    Masked Aadhaar shows a secondary VID line below the main (masked) number.
    Proxy: detect TWO distinct horizontal text bands in the bottom zone.
    """
    if bot_zone.size == 0:
        return False
    _, binary = cv2.threshold(bot_zone, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    proj = binary.sum(axis=1).astype(float)
    peak = proj.max()
    if peak == 0:
        return False
    proj /= peak   # normalise 0–1
    in_band   = False
    band_count = 0
    gap_after_band = False
    for val in proj:
        if val > 0.08:
            if not in_band:
                if band_count == 0 or gap_after_band:
                    band_count    += 1
                    gap_after_band = False
                in_band = True
        else:
            if in_band:
                gap_after_band = True
            in_band = False
    return band_count >= 2


def _is_address_absent(mid_zone: np.ndarray) -> bool:
    """
    Signal 3: address block absent → masked Aadhaar.
    Masked Aadhaar hides the address; the middle zone has very few ink pixels.
    """
    if mid_zone.size == 0:
        return True
    _, binary = cv2.threshold(mid_zone, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    density = float(binary.sum()) / (255.0 * binary.size)
    return density < 0.015   # < 1.5 % ink pixels → no address text


def _detect_xxxx_pattern(bot_zone: np.ndarray) -> bool:
    """
    Signal 1: XXXX masked-digit region in bottom zone.
    In many masked Aadhaar cards the first-8-digit area is rendered as a low-
    contrast grey block (or low-variance X characters) while the last 4 visible
    digits produce noticeably higher Laplacian variance on the right side.
    """
    if bot_zone.size == 0:
        return False
    h, w = bot_zone.shape
    num_row = bot_zone[:max(1, h // 2), :]   # top half = main number line
    if num_row.size == 0:
        return False
    lw   = 2 * w // 3
    left  = num_row[:, :lw]
    right = num_row[:, lw:]
    lv = float(cv2.Laplacian(left,  cv2.CV_64F).var()) if left.size  > 0 else 999.0
    rv = float(cv2.Laplacian(right, cv2.CV_64F).var()) if right.size > 0 else 0.0
    # XXXX area (left 2/3) is much lower-contrast than visible digits (right 1/3)
    return lv < 30 and rv > 80 and rv > lv * 2.5


def _detect_variant(card: np.ndarray) -> str:
    """
    Multi-signal masked vs full detection.
    Priority order (spec §FIX 1):
      1. XXXX digit pattern in bottom zone
      2. VID text band in bottom zone
      3. Address absent in middle zone
      4. Middle-zone std dev fallback (last resort only)
    """
    h, w = card.shape[:2]
    gray = cv2.cvtColor(card, cv2.COLOR_BGR2GRAY)

    top_e = int(h * 0.40)
    mid_e = int(h * 0.70)

    bot_zone = gray[mid_e:, :]
    mid_zone = gray[top_e:mid_e, :]

    if mid_zone.size == 0:
        return "unknown"

    # Signal 1 — XXXX pattern in bottom zone
    if _detect_xxxx_pattern(bot_zone):
        return "masked"

    # Signal 2 — VID number band present
    if _detect_vid_band(bot_zone):
        return "masked"

    # Signal 3 — address block absent in middle zone
    if _is_address_absent(mid_zone):
        return "masked"

    # Signal 4 — std dev fallback (last resort, never sole signal)
    if float(mid_zone.std()) < 18:
        return "masked"

    return "full"


# ── Watermark detection ───────────────────────────────────────────────────────

def _has_compression_artifacts(card: np.ndarray, source_format: str) -> bool:
    """
    FIX 8 — Detect JPEG 8×8 DCT block-boundary ringing.
    Only meaningful for JPG; PNG and PDF-rasterised images are exempt.
    Compares average pixel-difference at 8-pixel block boundaries vs
    non-boundary rows/cols.  A ratio > 1.5 with a minimum absolute
    boundary-diff > 5 indicates block artifacts from heavy re-compression.
    """
    if source_format != "jpg":
        return False
    gray = cv2.cvtColor(card, cv2.COLOR_BGR2GRAY).astype(np.int16)
    h, w = gray.shape

    boundary_diffs:     list[float] = []
    non_boundary_diffs: list[float] = []

    for y in range(1, h):
        diff = float(np.abs(gray[y, :] - gray[y - 1, :]).mean())
        (boundary_diffs if y % 8 == 0 else non_boundary_diffs).append(diff)

    for x in range(1, w):
        diff = float(np.abs(gray[:, x] - gray[:, x - 1]).mean())
        (boundary_diffs if x % 8 == 0 else non_boundary_diffs).append(diff)

    if not boundary_diffs or not non_boundary_diffs:
        return False

    avg_bound     = float(np.mean(boundary_diffs))
    avg_non_bound = float(np.mean(non_boundary_diffs))

    return avg_non_bound > 0 and avg_bound > avg_non_bound * 1.5 and avg_bound > 5.0


def _has_watermark(card: np.ndarray) -> bool:
    gray = cv2.cvtColor(card, cv2.COLOR_BGR2GRAY).astype(np.float32)
    f    = np.fft.fftshift(np.fft.fft2(gray))
    mag  = np.abs(f)
    h, w = mag.shape
    r    = min(h, w) // 10
    cy, cx = h // 2, w // 2
    mag[cy - r:cy + r, cx - r:cx + r] = 0   # zero-out DC
    mean_mag = float(mag.mean())
    max_mag  = float(mag.max())
    return mean_mag > 0 and max_mag / (mean_mag + 1e-9) > 1000


# ── Zone metrics ──────────────────────────────────────────────────────────────

def _zone_pcts(variant: str) -> Tuple[int, int, int]:
    if variant == "masked":
        return 50, 25, 25
    return 40, 30, 30


def _metrics(card: np.ndarray, variant: str) -> Dict[str, Any]:
    h, w = card.shape[:2]
    gray  = cv2.cvtColor(card, cv2.COLOR_BGR2GRAY)
    raw   = gray.copy()

    top_pct, mid_pct, bot_pct = _zone_pcts(variant)
    top_e = int(h * top_pct / 100)
    mid_e = int(h * (top_pct + mid_pct) / 100)

    def _blur(z: np.ndarray) -> float:
        return float(cv2.Laplacian(z, cv2.CV_64F).var()) if z.size > 0 else 0.0

    total_px = float(raw.size) or 1.0
    over_px  = float(np.sum(raw > 250))
    under_px = float(np.sum(raw < 5))
    glare_px = float(np.sum(raw > 245))

    bot_raw = raw[mid_e:, :]
    bot_tot = float(bot_raw.size) or 1.0
    bot_glare_px = float(np.sum(bot_raw > 245))

    return {
        "w": w, "h": h,
        "aspect":      round(w / h, 4) if h > 0 else 0.0,
        "global_blur": _blur(gray),
        "top_blur":    _blur(gray[:top_e, :]),
        "mid_blur":    _blur(gray[top_e:mid_e, :]),
        "bot_blur":    _blur(gray[mid_e:, :]),
        "overexposed":   over_px  / total_px * 100.0,
        "underexposed":  under_px / total_px * 100.0,
        "glare_full":    glare_px / total_px * 100.0,
        "glare_bot":     bot_glare_px / bot_tot * 100.0,
        "top_pct": top_pct, "mid_pct": mid_pct, "bot_pct": bot_pct,
    }


# ── Quality checks (returns checks dict, fail list, warn list) ────────────────

def _run_checks(
    m:         Dict[str, Any],
    variant:   str,
    photocopy: bool,
) -> Tuple[Dict[str, Any], List[Dict], List[Dict]]:
    fails: List[Dict] = []
    warns: List[Dict] = []

    # ── Aspect ratio (isolated card) ─────────────────────────────────────────
    ar_min = _AR_MIN_MASKED if variant == "masked" else _AR_MIN_FULL
    ar_ok  = ar_min <= m["aspect"] <= _AR_MAX
    if not ar_ok:
        fails.append({"check": "aspect_ratio", "zone": None,
                      "measured": m["aspect"],
                      "threshold": f"{ar_min} <= ratio <= {_AR_MAX}"})

    # ── Global blur ───────────────────────────────────────────────────────────
    g_fail_thr = _GLOBAL_BLUR_FAIL_PC if photocopy else _GLOBAL_BLUR_FAIL
    g_blur_ok  = m["global_blur"] >= g_fail_thr
    if not g_blur_ok:
        fails.append({"check": "global_blur", "zone": None,
                      "measured": round(m["global_blur"], 2),
                      "threshold": f">= {g_fail_thr}"})

    # ── Bottom zone blur ──────────────────────────────────────────────────────
    bot_fail = (_BOT_BLUR_FAIL_PC if photocopy else _BOT_BLUR_FAIL).get(variant, 20.0)
    bot_ok   = m["bot_blur"] >= bot_fail
    if not bot_ok:
        fails.append({"check": "bottom_zone_blur", "zone": "bottom",
                      "measured": round(m["bot_blur"], 2),
                      "threshold": f">= {bot_fail}"})

    # ── Top zone blur (WARN) ──────────────────────────────────────────────────
    top_thr    = _TOP_BLUR_WARN_PC if photocopy else _TOP_BLUR_WARN
    top_warned = m["top_blur"] < top_thr
    if top_warned:
        warns.append({"code": "top_zone_blur",
                      "details": f"Top zone blur {m['top_blur']:.1f} < {top_thr}",
                      "penalty": -0.08})

    # ── Middle zone blur (WARN) — FIX 3: photocopy threshold is variant-aware ────
    if photocopy:
        # Photocopy+masked: even lower threshold (greyscale + no address = very low variance)
        mid_thr  = _MID_BLUR_WARN_PC_MASKED if variant == "masked" else _MID_BLUR_WARN_PC_FULL
        mid_pen  = -0.05 if variant == "masked" else -0.10
    elif variant == "masked":
        mid_thr, mid_pen = _MID_BLUR_WARN_MASKED, -0.05
    else:
        mid_thr, mid_pen = _MID_BLUR_WARN_FULL, -0.10
    mid_warned = m["mid_blur"] < mid_thr
    mid_note   = "intentionally_hidden" if variant == "masked" else None
    if mid_warned:
        warns.append({"code": "middle_zone_blur",
                      "details": f"Middle zone blur {m['mid_blur']:.1f} < {mid_thr}",
                      "penalty": mid_pen})

    # ── Resolution ────────────────────────────────────────────────────────────
    res_ok     = m["w"] >= _RES_FAIL_W and m["h"] >= _RES_FAIL_H
    res_warned = False
    if not res_ok:
        fails.append({"check": "resolution", "zone": None,
                      "measured": f"{m['w']}x{m['h']}",
                      "threshold": f"w >= {_RES_FAIL_W} AND h >= {_RES_FAIL_H}"})
    elif m["w"] <= _RES_WARN_W or m["h"] <= _RES_WARN_H:
        res_warned = True
        warns.append({"code": "low_resolution",
                      "details": f"Resolution {m['w']}x{m['h']} below recommended {_RES_WARN_W}x{_RES_WARN_H}",
                      "penalty": -0.05})

    # ── Exposure — FIX 4: photocopy uses looser warn thresholds ─────────────────
    oe_fail = _OVEREXPOSE_FAIL_PC  if photocopy else _OVEREXPOSE_FAIL
    ue_fail = _UNDEREXPOSE_FAIL_PC if photocopy else _UNDEREXPOSE_FAIL
    oe_warn = _OVEREXPOSE_WARN_PC  if photocopy else _OVEREXPOSE_WARN
    ue_warn = _UNDEREXPOSE_WARN_PC if photocopy else _UNDEREXPOSE_WARN
    oe_ok   = m["overexposed"]  <= oe_fail
    ue_ok   = m["underexposed"] <= ue_fail
    oe_warned, ue_warned = False, False

    if not oe_ok:
        fails.append({"check": "overexposure", "zone": None,
                      "measured": round(m["overexposed"], 2),
                      "threshold": f"<= {oe_fail}%"})
    elif m["overexposed"] > oe_warn:
        oe_warned = True
        warns.append({"code": "mild_overexposure",
                      "details": f"Overexposure {m['overexposed']:.1f}% (warn threshold {oe_warn}%)",
                      "penalty": -0.08})

    if not ue_ok:
        fails.append({"check": "underexposure", "zone": None,
                      "measured": round(m["underexposed"], 2),
                      "threshold": f"<= {ue_fail}%"})
    elif m["underexposed"] > ue_warn:
        ue_warned = True
        warns.append({"code": "mild_underexposure",
                      "details": f"Underexposure {m['underexposed']:.1f}% (warn threshold {ue_warn}%)",
                      "penalty": -0.08})

    # ── Glare ─────────────────────────────────────────────────────────────────
    glare_skipped = photocopy
    glare_ok      = True
    glare_warned  = False
    bot_glare_fail = _GLARE_BOT_FAIL_MASKED if variant == "masked" else _GLARE_BOT_FAIL_FULL

    if not glare_skipped:
        if m["glare_bot"] > bot_glare_fail:
            glare_ok = False
            fails.append({"check": "bottom_zone_glare", "zone": "bottom",
                          "measured": round(m["glare_bot"], 2),
                          "threshold": f"<= {bot_glare_fail}%"})
        elif m["glare_full"] > _GLARE_WARN:
            glare_warned = True
            warns.append({"code": "mild_glare",
                          "details": f"Full-card glare {m['glare_full']:.1f}% > warn {_GLARE_WARN}%",
                          "penalty": -0.10})

    # ── Build checks dict (spec schema) ──────────────────────────────────────
    checks = {
        "blur": {
            "global_value":      round(m["global_blur"], 2),
            "global_threshold":  _GLOBAL_BLUR_FAIL,
            "global_pass":       g_blur_ok,
            "zones": {
                "top": {
                    "value":               round(m["top_blur"], 2),
                    "warn_threshold":      top_thr,
                    "hard_fail_threshold": None,
                    "pass":                not top_warned,
                    "warned":              top_warned,
                },
                "middle": {
                    "value":               round(m["mid_blur"], 2),
                    "warn_threshold":      mid_thr,
                    "hard_fail_threshold": None,
                    "pass":                not mid_warned,
                    "warned":              mid_warned,
                    "note":                mid_note,
                },
                "bottom": {
                    "value":               round(m["bot_blur"], 2),
                    "warn_threshold":      None,
                    "hard_fail_threshold": bot_fail,
                    "pass":                bot_ok,
                    "warned":              False,
                },
            },
            "pass": g_blur_ok and bot_ok,
        },
        "resolution": {
            "width":                     m["w"],
            "height":                    m["h"],
            "hard_fail_threshold_width":  _RES_FAIL_W,
            "hard_fail_threshold_height": _RES_FAIL_H,
            "warn_threshold_width":       _RES_WARN_W,
            "warn_threshold_height":      _RES_WARN_H,
            "pass":                      res_ok,
            "warned":                    res_warned,
        },
        "aspect_ratio": {
            "value":         m["aspect"],
            "min_threshold": ar_min,
            "max_threshold": _AR_MAX,
            "pass":          ar_ok,
            "note":          "checked on isolated front card only",
        },
        "overexposure": {
            "percent":             round(m["overexposed"], 2),
            "hard_fail_threshold": oe_fail,
            "warn_threshold":      oe_warn,
            "pass":                oe_ok,
            "warned":              oe_warned,
        },
        "underexposure": {
            "percent":             round(m["underexposed"], 2),
            "hard_fail_threshold": ue_fail,
            "warn_threshold":      ue_warn,
            "pass":                ue_ok,
            "warned":              ue_warned,
        },
        "glare": {
            "full_card_percent":   round(m["glare_full"], 2),
            "bottom_zone_percent": round(m["glare_bot"], 2),
            "hard_fail_threshold": bot_glare_fail if not glare_skipped else None,
            "warn_threshold":      _GLARE_WARN     if not glare_skipped else None,
            "pass":                glare_ok,
            "warned":              glare_warned,
            "skipped":             glare_skipped,
            "skip_reason":         "photocopy" if glare_skipped else None,
        },
    }

    return checks, fails, warns


# ── Quality score ─────────────────────────────────────────────────────────────

def _score(
    m:         Dict[str, Any],
    variant:   str,
    photocopy: bool,
    all_warns: List[Dict],
) -> Tuple[float, str, Dict[str, float], List[Dict], float, float]:
    """Returns (score, tier, gradients, penalties_applied, total_penalty, base_score)."""
    blur_gradient = min(1.0, m["global_blur"] / 80.0)

    if photocopy:
        zb = min(1.0, (m["top_blur"] / 40.0 + m["mid_blur"] / 30.0 + m["bot_blur"] / 45.0) / 3.0)
        gg = 1.0   # glare not applicable
    elif variant == "masked":
        zb = min(1.0, (m["top_blur"] / 50.0 + m["mid_blur"] / 30.0 + m["bot_blur"] / 50.0) / 3.0)
        gg = max(0.0, 1.0 - m["glare_full"] / 50.0)
    else:
        zb = min(1.0, (m["top_blur"] / 50.0 + m["mid_blur"] / 40.0 + m["bot_blur"] / 60.0) / 3.0)
        gg = max(0.0, 1.0 - m["glare_full"] / 50.0)

    eg = max(0.0, 1.0 - max(m["overexposed"] / 70.0, m["underexposed"] / 60.0))

    gradients = {
        "blur_gradient":      round(blur_gradient, 4),
        "zone_blur_gradient": round(zb, 4),
        "glare_gradient":     round(gg, 4),
        "exposure_gradient":  round(eg, 4),
    }

    base = round(0.35 * blur_gradient + 0.25 * zb + 0.25 * gg + 0.15 * eg, 4)

    penalties: List[Dict] = []
    total_pen = 0.0
    for w in all_warns:
        p = w.get("penalty", 0.0)
        if p != 0.0:
            penalties.append({"reason": w["code"], "penalty": p})
            total_pen += p
    total_pen = round(total_pen, 4)

    final = round(max(0.0, min(1.0, base + total_pen)), 4)

    tier = "reject"
    for thr, name in _QUALITY_TIERS:
        if final >= thr:
            tier = name
            break

    return final, tier, gradients, penalties, total_pen, base


# ── Fail-response helpers ─────────────────────────────────────────────────────

def _fail_resp(
    source_format: str,
    doc_type:      str,
    fail_check:    str,
    measured:      Any,
    threshold:     str,
    card_detected: bool = True,
) -> AadhaarQualityResponse:
    zero_g = {"blur_gradient": 0.0, "zone_blur_gradient": 0.0,
               "glare_gradient": 0.0, "exposure_gradient": 0.0}
    return AadhaarQualityResponse(
        overall_pass=False, quality_tier="reject",
        quality_score=0.0, quality_gate_multiplier=0.5,
        source_format=source_format, document_type=doc_type,
        card_variant="unknown", card_detected=card_detected,
        dual_side_detected=False, watermark_detected=False,
        photocopy_detected=False, scanned_copy_detected=False,
        ui_chrome_removed=False, perspective_corrected=False,
        orientation_corrected=False, zone_thresholds_adjusted=False,
        manual_review_required=True,
        isolated_card_dimensions={"width": 0, "height": 0},
        zone_boundaries_used={"top_zone_percent": 40, "middle_zone_percent": 30, "bottom_zone_percent": 30},
        checks={}, warnings=[],
        fail_reasons=[{"check": fail_check, "zone": None, "measured": measured, "threshold": threshold}],
        gradients=zero_g, penalties_applied=[],
        total_penalty=0.0, base_score=0.0,
    )


# ── Main endpoint ─────────────────────────────────────────────────────────────

@router.post("/quality/aadhaar", response_model=AadhaarQualityResponse)
async def check_aadhaar_quality(req: AadhaarQualityRequest) -> AadhaarQualityResponse:
    print(f"[ENDPOINT HIT] /ai/quality/aadhaar")
    print(f"[IMAGE URL] {req.image_url[:80]}...")

    # ── Fetch bytes ───────────────────────────────────────────────────────────
    try:
        data = await fetch_image(req.image_url)
    except Exception as exc:
        raise HTTPException(status_code=400,
                            detail={"error": "IMAGE_FETCH_FAILED", "code": str(exc)})

    source_format = _detect_format(data)

    # ── Decode ────────────────────────────────────────────────────────────────
    try:
        bgr, _ = _decode(data, source_format)
    except Exception as exc:
        return _fail_resp(source_format, "type3_single_front",
                          "invalid_image", str(exc), "valid_decodable_image",
                          card_detected=False)

    # ── Photocopy / scan ──────────────────────────────────────────────────────
    photocopy = _is_photocopy(bgr)
    scanned   = _is_scanned(bgr, photocopy)

    all_warns: List[Dict] = []

    if photocopy:
        all_warns.append({"code": "photocopy_detected",
                          "details": "Near-greyscale flat-contrast image — likely a photocopy",
                          "penalty": -0.15})
    if scanned:
        all_warns.append({"code": "scanned_copy_detected",
                          "details": "Flatbed scan characteristics detected",
                          "penalty": -0.05})

    # ── Document type ─────────────────────────────────────────────────────────
    doc_type, type_meta = _detect_doc_type(bgr, photocopy, scanned)

    # ── Back-side check (TYPE 6) ──────────────────────────────────────────────
    if doc_type != "type6_back_only" and _is_back_side(bgr):
        doc_type = "type6_back_only"
    if doc_type == "type6_back_only":
        return _fail_resp(source_format, "type6_back_only",
                          "back_side_only", "no_front_card", "front_side_required")

    # ── Dual-side and UI-chrome warnings ─────────────────────────────────────
    dual_side = type_meta.get("dual_side", False)
    if dual_side:
        pen = -0.03 if doc_type == "type1a_eaadhaar_a4" else -0.05
        all_warns.append({"code": "dual_side_detected",
                          "details": f"Both sides detected — document type: {doc_type}",
                          "penalty": pen})

    ui_chrome_removed = False
    if doc_type in ("type4a_maadhar_screenshot", "type4b_pdf_screenshot"):
        all_warns.append({"code": "ui_chrome_removed",
                          "details": "App / browser chrome removed before analysis",
                          "penalty": -0.03})
        ui_chrome_removed = True

    # ── Isolate front card ────────────────────────────────────────────────────
    try:
        card, persp, orient, chrome = _isolate_card(bgr, doc_type, type_meta)
    except Exception:
        card, persp, orient, chrome = bgr, False, False, False

    if card is None or card.size == 0 or min(card.shape[:2]) < 20:
        return _fail_resp(source_format, doc_type,
                          "card_not_detected", "no_card_boundary", "card_boundary_found",
                          card_detected=False)

    ui_chrome_removed = ui_chrome_removed or chrome

    # ── Variant + watermark ───────────────────────────────────────────────────
    variant           = _detect_variant(card)
    watermark_det     = _has_watermark(card)
    if watermark_det:
        all_warns.append({"code": "watermark_detected",
                          "details": "Background watermark pattern detected on card",
                          "penalty": -0.03})

    # ── Zone config ───────────────────────────────────────────────────────────
    top_pct, mid_pct, bot_pct = _zone_pcts(variant)

    # ── Metrics ───────────────────────────────────────────────────────────────
    m = _metrics(card, variant)

    # ── FIX 8: JPG compression artifact detection ─────────────────────────────
    if _has_compression_artifacts(card, source_format):
        all_warns.append({"code": "compressed_image",
                          "details": "JPEG 8×8 DCT block-boundary artifacts detected — image has been re-compressed",
                          "penalty": -0.05})

    # ── Quality checks ────────────────────────────────────────────────────────
    checks, check_fails, check_warns = _run_checks(m, variant, photocopy)
    all_warns.extend(check_warns)

    # Masked middle zone — always informational
    if variant == "masked":
        all_warns.append({"code": "masked_middle_zone",
                          "details": "Middle zone (address) intentionally hidden — masked Aadhaar",
                          "penalty": 0.0})

    fail_reasons = check_fails

    # ── Score ─────────────────────────────────────────────────────────────────
    quality_score, quality_tier, gradients, penalties_applied, total_penalty, base_score = \
        _score(m, variant, photocopy, all_warns)

    overall_pass      = len(fail_reasons) == 0
    manual_review     = photocopy or (quality_score < 0.50)
    gate_multiplier   = round(max(0.5, quality_score), 4)

    h_card, w_card = card.shape[:2]

    print(
        f"[AADHAAR QUALITY] type={doc_type} variant={variant} card={w_card}x{h_card} "
        f"score={quality_score} tier={quality_tier} pass={overall_pass} "
        f"fails={len(fail_reasons)} warns={len(all_warns)}"
    )

    return AadhaarQualityResponse(
        overall_pass=overall_pass,
        quality_tier=quality_tier,
        quality_score=quality_score,
        quality_gate_multiplier=gate_multiplier,
        source_format=source_format,
        document_type=doc_type,
        card_variant=variant,
        card_detected=True,
        dual_side_detected=dual_side,
        watermark_detected=watermark_det,
        photocopy_detected=photocopy,
        scanned_copy_detected=scanned,
        ui_chrome_removed=ui_chrome_removed,
        perspective_corrected=persp,
        orientation_corrected=orient,
        zone_thresholds_adjusted=photocopy,
        manual_review_required=manual_review,
        isolated_card_dimensions={"width": w_card, "height": h_card},
        zone_boundaries_used={
            "top_zone_percent":    top_pct,
            "middle_zone_percent": mid_pct,
            "bottom_zone_percent": bot_pct,
        },
        checks=checks,
        warnings=all_warns,
        fail_reasons=fail_reasons,
        gradients=gradients,
        penalties_applied=penalties_applied,
        total_penalty=total_penalty,
        base_score=base_score,
    )
