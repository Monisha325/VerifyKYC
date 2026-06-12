"""
POST /ai/qr/pan

PAN card QR verification (Stage A — authoritative path).

Flow:
  1. Decode QR from card image (pyzbar → cv2 fallback)
  2. Parse payload: JSON / XML / plain-text / zlib-compressed binary
  3. Extract fields: PAN (masked), name, father_name, DOB, gender, photo (base64)
  4. Attempt ITD digital-signature verification when PAN_ITD_CERT_PEM env var is set
  5. Return structured result; face match runs separately via /ai/face/verify-b64

verification_path returned:
  AUTHORITATIVE_ONE — QR decoded + ITD signature verified
  UNVERIFIED        — QR decoded + fields extracted; cert unavailable (no sig check)
  FALLBACK          — QR not found or payload unparseable → OCR-only path in Node

PII compliance:
  Full PAN is NEVER logged or returned.
  Only pan_masked (first 2 + "****" + last 2 chars) is exposed.
  photo_b64 is the QR-embedded face photo; it is used only for cross-check face
  matching in the Node pipeline and is NOT persisted.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import re
import threading
import time
import zlib
from typing import List, Optional
from xml.etree import ElementTree as ET

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
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding as _asym_padding
    from cryptography.x509 import load_pem_x509_certificate, load_der_x509_certificate
    from cryptography.exceptions import InvalidSignature as _InvalidSignature
    _CRYPTO_OK = True
except Exception:
    _CRYPTO_OK = False

# ── ITD certificate config ────────────────────────────────────────────────────
# Set PAN_ITD_CERT_PEM to either a PEM string or a file path.
# Without it, signature verification is skipped and verification_path='UNVERIFIED'.

_ITD_CERT_PEM = os.environ.get("PAN_ITD_CERT_PEM", "")

_itd_cert_lock      = threading.Lock()
_itd_cached_pubkey  = None
_itd_cert_loaded_at = 0.0
_ITD_CERT_TTL_S     = 24 * 3600


def _load_itd_pubkey():
    global _itd_cached_pubkey, _itd_cert_loaded_at
    if not _CRYPTO_OK or not _ITD_CERT_PEM:
        return None

    with _itd_cert_lock:
        if _itd_cached_pubkey is not None and (time.time() - _itd_cert_loaded_at) < _ITD_CERT_TTL_S:
            return _itd_cached_pubkey
        try:
            if os.path.isfile(_ITD_CERT_PEM):
                with open(_ITD_CERT_PEM, "rb") as fh:
                    cert_bytes = fh.read()
            else:
                cert_bytes = _ITD_CERT_PEM.encode()

            if b"-----BEGIN CERTIFICATE-----" in cert_bytes:
                cert = load_pem_x509_certificate(cert_bytes)
            else:
                cert = load_der_x509_certificate(cert_bytes)

            _itd_cached_pubkey  = cert.public_key()
            _itd_cert_loaded_at = time.time()
            print("[PAN QR] ITD cert loaded")
            return _itd_cached_pubkey
        except Exception as exc:
            print(f"[PAN QR] ITD cert load error: {exc}")
            return None


# ── Schemas ───────────────────────────────────────────────────────────────────

class PanQrRequest(BaseModel):
    image_url: str


class PanQrResponse(BaseModel):
    qr_found:          bool
    verification_path: str            # 'AUTHORITATIVE_ONE' | 'UNVERIFIED' | 'FALLBACK'
    card_authentic:    bool
    # Masked PII — safe to store and log
    pan_masked:        Optional[str]  # "AB****4F"
    name:              Optional[str]
    father_name:       Optional[str]
    dob:               Optional[str]
    gender:            Optional[str]
    entity_type:       Optional[str]  # P=individual, C=company, H=huf, F=firm, …
    # Photo (for Stage B face match only — not persisted)
    photo_present:     bool
    photo_b64:         Optional[str]  # base64 JPEG from QR payload
    # Verification
    signature_valid:   Optional[bool] # None = not attempted
    # Fraud signals
    fraud_flags:       List[str]
    fail_reason:       Optional[str]


# ── PAN helpers ───────────────────────────────────────────────────────────────

_PAN_RE = re.compile(r'\b([A-Z]{5}[0-9]{4}[A-Z])\b')

# 4th character of PAN encodes entity type
_ENTITY_TYPES: dict[str, str] = {
    'P': 'individual', 'C': 'company', 'H': 'huf',
    'F': 'firm',       'B': 'boi',     'A': 'aop',
    'T': 'trust',      'J': 'aop_boi', 'G': 'government',
}


def _mask_pan(pan: str) -> str:
    if len(pan) < 4:
        return pan
    return pan[:2] + "****" + pan[-2:]


# ── QR raw payload extraction ─────────────────────────────────────────────────

def _decode_qr_raw(bgr: np.ndarray) -> List[bytes]:
    """Return list of raw QR payload bytes found in the image."""
    results: List[bytes] = []

    if _PYZBAR_OK and _pyzbar_decode is not None:
        try:
            pil = Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
            for sym in _pyzbar_decode(pil):
                if sym.type == "QRCODE" and sym.data:
                    results.append(sym.data)
        except Exception as exc:
            print(f"[PAN QR] pyzbar error: {exc}")

    if not results:
        try:
            detector = cv2.QRCodeDetector()
            retval, decoded_info, _, _ = detector.detectAndDecodeMulti(bgr)
            if retval:
                for info in decoded_info:
                    if info:
                        results.append(info.encode("utf-8", errors="replace"))
        except Exception as exc:
            print(f"[PAN QR] cv2 detector error: {exc}")

    # CLAHE retry for low-contrast cards
    if not results:
        try:
            gray    = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
            clahe   = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            enhanced = clahe.apply(gray)
            bgr_enh  = cv2.cvtColor(enhanced, cv2.COLOR_GRAY2BGR)
            detector = cv2.QRCodeDetector()
            retval, decoded_info, _, _ = detector.detectAndDecodeMulti(bgr_enh)
            if retval:
                for info in decoded_info:
                    if info:
                        results.append(info.encode("utf-8", errors="replace"))
        except Exception as exc:
            print(f"[PAN QR] cv2 CLAHE retry error: {exc}")

    return results


# ── Payload parsing ───────────────────────────────────────────────────────────

def _try_decompress(data: bytes) -> Optional[bytes]:
    for wbits in (15, -15, 47):   # zlib, raw deflate, gzip
        try:
            return zlib.decompress(data, wbits=wbits)
        except Exception:
            pass
    return None


def _parse_payload(raw: bytes) -> dict:
    """
    Try to parse PAN QR payload into a field dict.
    Tries: UTF-8 text→JSON, text→XML, text→regex; then zlib-decompress and retry.
    Returns keys: pan, name, father_name, dob, gender, photo_b64, signature_b64, payload_type
    """
    base: dict = {
        "pan": None, "name": None, "father_name": None,
        "dob": None, "gender": None,
        "photo_b64": None, "signature_b64": None,
        "payload_type": "unknown",
    }

    def _try_text(text: str) -> bool:
        nonlocal base
        text = text.strip()
        if not text:
            return False

        # JSON
        try:
            obj = json.loads(text)
            if isinstance(obj, dict):
                base["pan"]           = obj.get("pan") or obj.get("PAN") or obj.get("Pan")
                base["name"]          = obj.get("name") or obj.get("Name") or obj.get("nm")
                base["father_name"]   = (obj.get("father_name") or obj.get("fatherName")
                                         or obj.get("fn") or obj.get("father"))
                base["dob"]           = obj.get("dob") or obj.get("DOB") or obj.get("dateOfBirth")
                base["gender"]        = obj.get("gender") or obj.get("Gender") or obj.get("gen")
                base["photo_b64"]     = obj.get("photo") or obj.get("Photo") or obj.get("photo_b64")
                base["signature_b64"] = obj.get("signature") or obj.get("Signature")
                base["payload_type"]  = "json"
                return bool(base["pan"])
        except (json.JSONDecodeError, ValueError):
            pass

        # XML
        try:
            if text.startswith("<?") or text.startswith("<"):
                root = ET.fromstring(text)

                def _find(*tags: str) -> Optional[str]:
                    for tag in tags:
                        el = root.find(f".//{tag}")
                        if el is not None and el.text:
                            return el.text.strip()
                    return None

                base["pan"]           = _find("PAN_NO", "Pan", "pan", "PanNumber", "PANNO")
                base["name"]          = _find("NAME", "Name", "name")
                base["father_name"]   = _find("FATHER_NAME", "FatherName", "father_name", "FATHERNAME")
                base["dob"]           = _find("DOB", "Dob", "dob", "DateOfBirth", "DATEOFBIRTH")
                base["gender"]        = _find("GENDER", "Gender", "gender")
                base["photo_b64"]     = _find("Photo", "photo", "PHOTO", "PhotoData")
                base["signature_b64"] = _find("Signature", "signature", "SIGNATURE")
                base["payload_type"]  = "xml"
                return bool(base["pan"])
        except ET.ParseError:
            pass

        # Pipe / comma / newline-delimited plain text — extract PAN via regex
        pan_match = _PAN_RE.search(text)
        if pan_match:
            base["pan"] = pan_match.group(1)
            parts       = [p.strip() for p in re.split(r"[|\n,;]", text) if p.strip()]
            pan_idx     = next((i for i, p in enumerate(parts) if _PAN_RE.match(p)), -1)
            if pan_idx >= 0:
                for i, p in enumerate(parts):
                    if i == pan_idx:
                        continue
                    if re.match(r"\d{2}[/-]\d{2}[/-]\d{4}", p):
                        base["dob"] = p
                    elif re.match(r"^(M|F|Male|Female|MALE|FEMALE|O|Other|T)$", p, re.I):
                        base["gender"] = p
                    elif not base["name"] and i < pan_idx and len(p) > 2:
                        base["name"] = p
                    elif not base["father_name"] and base["name"] and len(p) > 2:
                        base["father_name"] = p
            base["payload_type"] = "plain_text"
            return True

        return False

    # Attempt 1: raw bytes as UTF-8
    try:
        if _try_text(raw.decode("utf-8", errors="replace")):
            return base
    except Exception:
        pass

    # Attempt 2: zlib-decompress → UTF-8
    decompressed = _try_decompress(raw)
    if decompressed:
        try:
            if _try_text(decompressed.decode("utf-8", errors="replace")):
                return base
        except Exception:
            pass

    return base


# ── Signature verification ─────────────────────────────────────────────────────

def _verify_itd_signature(payload_raw: bytes, signature_b64: str, pub_key) -> bool:
    """RSA-PKCS1v15-SHA256 signature check against the ITD certificate public key."""
    if not _CRYPTO_OK or pub_key is None:
        return False
    try:
        sig_bytes = base64.b64decode(signature_b64)
        pub_key.verify(sig_bytes, payload_raw, _asym_padding.PKCS1v15(), hashes.SHA256())
        return True
    except _InvalidSignature:
        return False
    except Exception as exc:
        print(f"[PAN QR] sig verify error: {exc}")
        return False


# ── Core logic (synchronous, runs in thread-pool executor) ────────────────────

def _run_pan_qr(bgr: np.ndarray) -> PanQrResponse:
    fraud_flags: List[str] = []

    raw_payloads = _decode_qr_raw(bgr)
    print(f"[PAN QR] found {len(raw_payloads)} QR payload(s)")

    if not raw_payloads:
        return PanQrResponse(
            qr_found=False, verification_path="FALLBACK", card_authentic=False,
            pan_masked=None, name=None, father_name=None, dob=None, gender=None,
            entity_type=None, photo_present=False, photo_b64=None,
            signature_valid=None, fraud_flags=[], fail_reason="no_qr_found",
        )

    # Try each payload, keep the first that yields a PAN field
    parsed:   Optional[dict] = None
    raw_best: bytes           = b""
    for raw in raw_payloads:
        p = _parse_payload(raw)
        if p.get("pan"):
            parsed   = p
            raw_best = raw
            break

    if not parsed or not parsed.get("pan"):
        return PanQrResponse(
            qr_found=True, verification_path="FALLBACK", card_authentic=False,
            pan_masked=None, name=None, father_name=None, dob=None, gender=None,
            entity_type=None, photo_present=False, photo_b64=None,
            signature_valid=None, fraud_flags=[], fail_reason="qr_parse_failed",
        )

    pan_raw      = str(parsed["pan"]).upper().strip()
    pan_masked   = _mask_pan(pan_raw)
    entity_char  = pan_raw[3] if len(pan_raw) >= 4 else None
    entity_type  = _ENTITY_TYPES.get(entity_char, None) if entity_char else None

    photo_b64    = parsed.get("photo_b64")
    photo_present = bool(photo_b64)
    sig_b64      = parsed.get("signature_b64")

    # ── Signature verification ────────────────────────────────────────────────
    pub_key            = _load_itd_pubkey()
    sig_valid: Optional[bool] = None

    if sig_b64:
        if pub_key is None:
            # Cert unavailable — cannot verify; treat as unverifiable not as forgery
            print("[PAN QR] ITD cert not configured — skipping signature, marking UNVERIFIED")
            sig_valid = None   # cert missing → UNVERIFIED, not a fraud flag   # mock as valid instead of None
        else:
            sig_valid = _verify_itd_signature(raw_best, sig_b64, pub_key)
            print(f"[PAN QR] signature_valid={sig_valid}")
            if sig_valid is False:
                fraud_flags.append("qr_signature_invalid")

    # ── Determine verification path ───────────────────────────────────────────
    if "qr_signature_invalid" in fraud_flags:
        verification_path = "FALLBACK"   # hard-fail in pipeline.ts
        card_authentic    = False
    elif sig_valid is True:
        verification_path = "AUTHORITATIVE_ONE"
        card_authentic    = True
    else:
        # sig_valid is None: either no cert, or no signature field in payload
        verification_path = "UNVERIFIED"
        card_authentic    = False

    print(f"[PAN QR] verification_path={verification_path} pan_masked={pan_masked} "
          f"entity_type={entity_type}")

    return PanQrResponse(
        qr_found=True,
        verification_path=verification_path,
        card_authentic=card_authentic,
        pan_masked=pan_masked,
        name=parsed.get("name"),
        father_name=parsed.get("father_name"),
        dob=parsed.get("dob"),
        gender=parsed.get("gender"),
        entity_type=entity_type,
        photo_present=photo_present,
        photo_b64=photo_b64,
        signature_valid=sig_valid,
        fraud_flags=fraud_flags,
        fail_reason=None,
    )


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.post("/qr/pan", response_model=PanQrResponse)
async def verify_pan_qr(req: PanQrRequest) -> PanQrResponse:
    print(f"[ENDPOINT HIT] /ai/qr/pan  url={req.image_url[:80]}...")

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
    return await loop.run_in_executor(None, _run_pan_qr, bgr)
