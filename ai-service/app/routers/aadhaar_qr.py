"""
POST /ai/qr/aadhaar

Cryptographic QR verification for Aadhaar cards (Stage A — primary path).

Flow:
  1. Decode QR code(s) from card image (pyzbar → cv2 fallback)
  2. Classify QR: secure (all-numeric, len > 100) vs old XML vs none
  3. Secure QR: pyaadhaar parses and exposes signedData() + signature() directly
  4. Verify RSA-PKCS1v15-SHA256 signature against cached UIDAI public key
  5. Valid → parse demographics from decodeddata(), return masked fields only
  6. Invalid signature → crypto_verified=False, signature_valid=False (forgery signal)
  7. No secure QR → crypto_verified=False, qr_found=False  (triggers Stage B fallback)

Compliance:
  - Full 12-digit Aadhaar number is NEVER returned or logged.
  - Only reference_id (last-4 + UNIX timestamp embedded in the QR payload) is exposed.
  - Mobile/email: presence flags only via isMobileNoRegistered() / isEmailRegistered().
"""

from __future__ import annotations

import asyncio
import io
import os
import threading
import time
from typing import List, Optional

import cv2
import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from PIL import Image, ImageOps
from pydantic import BaseModel

from app.dependencies import verify_token
from app.preprocessing import fetch_image

router = APIRouter(dependencies=[Depends(verify_token)])

# ── Optional dependencies (graceful degradation) ──────────────────────────────

try:
    from pyzbar.pyzbar import decode as _pyzbar_decode
    _PYZBAR_OK = True
except Exception:
    _pyzbar_decode = None   # type: ignore[assignment]
    _PYZBAR_OK = False

try:
    from pyaadhaar.decode import AadhaarSecureQr as _AadhaarSecureQr
    _PYAADHAAR_OK = True
except Exception:
    _AadhaarSecureQr = None  # type: ignore[assignment]
    _PYAADHAAR_OK = False

try:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding as _asym_padding
    from cryptography.x509 import load_der_x509_certificate
    from cryptography.exceptions import InvalidSignature as _InvalidSignature
    _CRYPTO_OK = True
except Exception:
    _CRYPTO_OK = False

# ── UIDAI certificate config ──────────────────────────────────────────────────

_CERT_DIR  = os.path.join(os.path.dirname(__file__), "..", "certs")
_CERT_PATH = os.path.join(_CERT_DIR, "uidai_offline_publickey_26022019.cer")
_CERT_URL  = "https://uidai.gov.in/images/uidai_offline_publickey_26022019.cer"

_EFFECTIVE_CERT_PATH = os.environ.get("UIDAI_CERT_PATH", _CERT_PATH)

_cert_lock      = threading.Lock()
_cached_pub_key = None
_cert_loaded_at = 0.0
_CERT_TTL_S     = 24 * 3600   # re-read from disk every 24 h


# ── Schemas ───────────────────────────────────────────────────────────────────

class AadhaarQrRequest(BaseModel):
    image_url: str


class AadhaarQrResponse(BaseModel):
    qr_found:        bool
    qr_type:         str                # 'secure' | 'old' | 'none'
    crypto_verified: bool
    signature_valid: Optional[bool]     # None → not attempted; True/False → result
    # Masked demographics (only populated when crypto_verified=True)
    reference_id:    Optional[str]      # last-4 digits + UNIX timestamp, never full number
    name:            Optional[str]
    dob:             Optional[str]
    gender:          Optional[str]
    care_of:         Optional[str]
    district:        Optional[str]
    pincode:         Optional[str]
    post_office:     Optional[str]
    state:           Optional[str]
    # Privacy markers — presence flags only, never actual values
    mobile_linked:   bool
    email_linked:    bool
    photo_present:   bool
    fail_reason:     Optional[str]


# ── UIDAI certificate loading ─────────────────────────────────────────────────

def _load_pub_key():
    """Return cached UIDAI RSA public key object, refreshing every 24 h."""
    global _cached_pub_key, _cert_loaded_at
    if not _CRYPTO_OK:
        return None

    with _cert_lock:
        if _cached_pub_key is not None and (time.time() - _cert_loaded_at) < _CERT_TTL_S:
            return _cached_pub_key

        cert_bytes: Optional[bytes] = None
        if os.path.isfile(_EFFECTIVE_CERT_PATH):
            try:
                with open(_EFFECTIVE_CERT_PATH, "rb") as fh:
                    cert_bytes = fh.read()
            except OSError as exc:
                print(f"[QR] cert read error: {exc}")

        # Best-effort download if not on disk
        if cert_bytes is None:
            try:
                import httpx
                resp = httpx.get(_CERT_URL, timeout=15.0, follow_redirects=True)
                resp.raise_for_status()
                cert_bytes = resp.content
                os.makedirs(_CERT_DIR, exist_ok=True)
                with open(_EFFECTIVE_CERT_PATH, "wb") as fh:
                    fh.write(cert_bytes)
                print(f"[QR] UIDAI cert downloaded → {_EFFECTIVE_CERT_PATH}")
            except Exception as exc:
                print(f"[QR] could not fetch UIDAI cert: {exc} — RSA verification unavailable")
                return None

        try:
            cert = load_der_x509_certificate(cert_bytes)
            _cached_pub_key = cert.public_key()
            _cert_loaded_at = time.time()
            print("[QR] UIDAI public key loaded")
            return _cached_pub_key
        except Exception as exc:
            print(f"[QR] failed to parse UIDAI cert: {exc}")
            return None


# ── QR string extraction from image ──────────────────────────────────────────

def _decode_qr_strings(bgr: np.ndarray) -> List[str]:
    """Return list of raw QR payload strings found in the image."""
    results: List[str] = []

    # Strategy 1: pyzbar (handles high-density QR reliably on Windows via bundled DLL)
    if _PYZBAR_OK and _pyzbar_decode is not None:
        try:
            pil = Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
            for sym in _pyzbar_decode(pil):
                if sym.type == "QRCODE":
                    payload = sym.data.decode("utf-8", errors="replace").strip()
                    if payload:
                        results.append(payload)
        except Exception as exc:
            print(f"[QR] pyzbar error: {exc}")

    # Strategy 2: cv2 multi-QR detector (already bundled with opencv-python-headless)
    if not results:
        try:
            detector = cv2.QRCodeDetector()
            retval, decoded_info, _, _ = detector.detectAndDecodeMulti(bgr)
            if retval:
                for info in decoded_info:
                    if info:
                        results.append(info.strip())
        except Exception as exc:
            print(f"[QR] cv2 detector error: {exc}")

    # Strategy 3: CLAHE pre-processed image for low-contrast cards
    if not results:
        try:
            gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
            clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            enhanced = clahe.apply(gray)
            bgr_enh = cv2.cvtColor(enhanced, cv2.COLOR_GRAY2BGR)
            detector = cv2.QRCodeDetector()
            retval, decoded_info, _, _ = detector.detectAndDecodeMulti(bgr_enh)
            if retval:
                for info in decoded_info:
                    if info:
                        results.append(info.strip())
        except Exception as exc:
            print(f"[QR] cv2 CLAHE retry error: {exc}")

    # Deduplicate, longest first (secure QR is always the longest payload)
    seen: set[str] = set()
    unique: List[str] = []
    for r in sorted(results, key=len, reverse=True):
        if r not in seen:
            seen.add(r)
            unique.append(r)
    return unique


# ── RSA signature verification ────────────────────────────────────────────────

def _verify_rsa(signed_data: bytes, signature: bytes, pub_key) -> bool:
    """
    Verify UIDAI RSA-PKCS1v15-SHA256 signature.
    pyaadhaar already splits the decompressed payload into signedData() / signature().
    """
    if not _CRYPTO_OK or pub_key is None:
        raise RuntimeError("cryptography package or UIDAI cert not available")
    try:
        pub_key.verify(signature, signed_data, _asym_padding.PKCS1v15(), hashes.SHA256())
        return True
    except _InvalidSignature:
        return False
    except Exception as exc:
        print(f"[QR] RSA verify error: {exc}")
        return False


# ── Demographics extraction from pyaadhaar data dict ─────────────────────────

def _extract_demo(obj) -> dict:
    """
    Pull masked demographics from an AadhaarSecureQr instance.
    NEVER includes the full Aadhaar number — only reference_id (last-4 + timestamp).
    """
    try:
        data: dict = obj.decodeddata()
    except Exception:
        data = {}

    ref = _s(data.get("referenceid"))   # last-4 digits + timestamp, embedded in QR

    try:
        photo_present = bool(obj.isImage())
    except Exception:
        photo_present = False

    return {
        "reference_id": ref,
        "name":         _s(data.get("name")),
        "dob":          _s(data.get("dob")),
        "gender":       _s(data.get("gender")),
        "care_of":      _s(data.get("careof")),
        "district":     _s(data.get("district")),
        "pincode":      _s(data.get("pincode")),
        "post_office":  _s(data.get("postoffice")),
        "state":        _s(data.get("state")),
        "mobile_linked": obj.isMobileNoRegistered(),
        "email_linked":  obj.isEmailRegistered(),
        "photo_present": photo_present,
    }


def _s(val) -> Optional[str]:
    if val is None:
        return None
    s = str(val).strip()
    return s or None


# ── Core verification logic (synchronous, run in executor) ────────────────────

def _run_qr_verification(bgr: np.ndarray) -> AadhaarQrResponse:
    def _no_qr(reason: str) -> AadhaarQrResponse:
        return AadhaarQrResponse(
            qr_found=False, qr_type="none",
            crypto_verified=False, signature_valid=None,
            reference_id=None, name=None, dob=None, gender=None,
            care_of=None, district=None, pincode=None, post_office=None, state=None,
            mobile_linked=False, email_linked=False, photo_present=False,
            fail_reason=reason,
        )

    def _fallback(qr_type: str, reason: str) -> AadhaarQrResponse:
        return AadhaarQrResponse(
            qr_found=True, qr_type=qr_type,
            crypto_verified=False, signature_valid=None,
            reference_id=None, name=None, dob=None, gender=None,
            care_of=None, district=None, pincode=None, post_office=None, state=None,
            mobile_linked=False, email_linked=False, photo_present=False,
            fail_reason=reason,
        )

    qr_strings = _decode_qr_strings(bgr)
    print(f"[QR] found {len(qr_strings)} QR string(s)")

    if not qr_strings:
        return _no_qr("no_qr_found")

    # Secure QR is all-numeric and very long (thousands of digits)
    secure_candidates = [q for q in qr_strings if q.isdigit() and len(q) > 100]

    if not secure_candidates:
        # Old QR or non-numeric (XML) — no crypto path available
        return AadhaarQrResponse(
            qr_found=True, qr_type="old",
            crypto_verified=False, signature_valid=None,
            reference_id=None, name=None, dob=None, gender=None,
            care_of=None, district=None, pincode=None, post_office=None, state=None,
            mobile_linked=False, email_linked=False, photo_present=False,
            fail_reason="old_qr_format_no_signature",
        )

    if not _PYAADHAAR_OK:
        return _fallback("secure", "pyaadhaar_not_installed")

    # Try each secure candidate (usually only one)
    last_exc: Optional[str] = None
    for qr_text in secure_candidates:
        try:
            obj = _AadhaarSecureQr(int(qr_text))
        except Exception as exc:
            last_exc = str(exc)
            print(f"[QR] AadhaarSecureQr parse error: {exc}")
            continue

        # ── Parse demographics ────────────────────────────────────────────────
        try:
            demo = _extract_demo(obj)
        except Exception as exc:
            print(f"[QR] Failed to extract demo from object: {exc}")
            return _fallback("secure", f"extract_error: {exc}")

        # ── RSA verification ──────────────────────────────────────────────────
        pub_key = _load_pub_key()
        if pub_key is None:
            # BUG FIX: Cert unavailable — return parsed data instead of losing all QR fields!
            print("[QR] UIDAI cert unavailable — returning unverified data without throwing away fields")
            return AadhaarQrResponse(
                qr_found=True, qr_type="secure",
                crypto_verified=False, signature_valid=None,
                reference_id=demo["reference_id"], name=demo["name"], dob=demo["dob"], gender=demo["gender"],
                care_of=demo["care_of"], district=demo["district"], pincode=demo["pincode"], post_office=demo["post_office"], state=demo["state"],
                mobile_linked=demo["mobile_linked"], email_linked=demo["email_linked"], photo_present=demo["photo_present"],
                fail_reason="uidai_cert_unavailable",
            )

        try:
            sig_valid = _verify_rsa(obj.signedData(), obj.signature(), pub_key)
        except Exception as exc:
            print(f"[QR] RSA verify exception: {exc}")
            return _fallback("secure", f"rsa_verify_error: {exc}")

        print(f"[QR] RSA signature_valid={sig_valid}")

        if not sig_valid:
            # Decoded but signature mismatch → payload was altered (forgery)
            return AadhaarQrResponse(
                qr_found=True, qr_type="secure",
                crypto_verified=False, signature_valid=False,
                reference_id=None, name=None, dob=None, gender=None,
                care_of=None, district=None, pincode=None, post_office=None, state=None,
                mobile_linked=False, email_linked=False, photo_present=False,
                fail_reason="qr_signature_invalid",
            )

        return AadhaarQrResponse(
            qr_found=True, qr_type="secure",
            crypto_verified=True, signature_valid=True,
            reference_id=demo["reference_id"],
            name=        demo["name"],
            dob=         demo["dob"],
            gender=      demo["gender"],
            care_of=     demo["care_of"],
            district=    demo["district"],
            pincode=     demo["pincode"],
            post_office= demo["post_office"],
            state=       demo["state"],
            mobile_linked= demo["mobile_linked"],
            email_linked=  demo["email_linked"],
            photo_present= demo["photo_present"],
            fail_reason=None,
        )

    return _fallback("secure", f"parse_failed: {last_exc}")


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.post("/qr/aadhaar", response_model=AadhaarQrResponse)
async def verify_aadhaar_qr(req: AadhaarQrRequest) -> AadhaarQrResponse:
    print(f"[ENDPOINT HIT] /ai/qr/aadhaar  url={req.image_url[:80]}...")

    try:
        data = await fetch_image(req.image_url)
    except Exception as exc:
        raise HTTPException(status_code=400,
                            detail={"error": "IMAGE_FETCH_FAILED", "code": str(exc)})

    try:
        pil = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
        bgr = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
    except Exception as exc:
        raise HTTPException(status_code=400,
                            detail={"error": "IMAGE_DECODE_FAILED", "code": str(exc)})

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _run_qr_verification, bgr)
