"""
POST /ai/face/detect  — locate faces in an image
POST /ai/face/verify  — compare selfie against ID-document photo

Face matching uses dlib's ResNet face-encoder via the `face_recognition`
wrapper — not DeepFace/TensorFlow/ArcFace. The previous TensorFlow+DeepFace
stack realistically needs 700MB+ RSS once ArcFace weights are loaded, which
OOM-crashed Render's free tier (512MB ceiling). dlib's encoder is imported
lazily on first call (same pattern as before) and its actual measured
footprint is far smaller — see the memory measurement in the accompanying
report.

Face detection uses dlib's HOG detector (primary, with per-detection
confidence scores), falling back to OpenCV's Haar cascade only if HOG finds
nothing — mirroring the previous primary/fallback structure.
"""

from __future__ import annotations

import asyncio
import base64
import io
import threading
from typing import Any, List, Optional

import cv2
import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from PIL import Image, ImageOps
from pydantic import BaseModel

from app.config import settings
from app.dependencies import verify_token
from app.preprocessing import load_raw_rgb

router = APIRouter(dependencies=[Depends(verify_token)])

# ── Lazy face_recognition/dlib loader — import deferred to first call ────────

_face_lock:        threading.Lock = threading.Lock()
_face_recognition:  Any            = None
_dlib_module:       Any            = None
_dlib_detector:     Any            = None
_face_model_ready:  bool           = False

_MATCH_THRESHOLD = 0.6  # face_recognition's own documented standard threshold —
# unlike the old ArcFace override (0.88, empirically tuned on real ID photos),
# this hasn't been retuned against real Aadhaar/PAN images, since none were
# available to test against. Revisit if real-world false-rejects show up.


def _get_face_recognition() -> Any:
    """Return the face_recognition module, importing on the very first call."""
    global _face_recognition
    if _face_recognition is None:
        with _face_lock:
            if _face_recognition is None:
                print("[FACE] Importing face_recognition (first call)...")
                import face_recognition as _fr
                _face_recognition = _fr
                print("[FACE] face_recognition imported.")
    return _face_recognition


def _get_dlib_detector() -> Any:
    """Return dlib's HOG frontal-face detector, importing on first call."""
    global _dlib_module, _dlib_detector
    if _dlib_detector is None:
        with _face_lock:
            if _dlib_detector is None:
                import dlib as _dlib
                _dlib_module = _dlib
                _dlib_detector = _dlib.get_frontal_face_detector()
    return _dlib_detector


def _ensure_face_model_ready() -> None:
    """
    Trigger the face_recognition/dlib import on first call. No-op after that.

    NB: face_recognition loads its dlib shape-predictor and ResNet encoder
    weights as module-level globals the moment it's imported — there's no
    separate "build model" step the way DeepFace had. A synthetic-image
    warmup encoding was tried here and removed: running dlib's landmark
    predictor on a degenerate all-black image with a forced bounding box
    reproducibly hung indefinitely (confirmed via direct testing — CPU usage
    stayed flat for 20+s, not just slow). Real face crops never hit this
    path, so the import alone is sufficient warmup.
    """
    global _face_model_ready
    if _face_model_ready:
        return
    # _get_face_recognition() has its own internal lock around the actual
    # import — do not wrap this call in _face_lock too, since that lock is
    # non-reentrant and a thread already holding it would deadlock itself.
    print("[FACE] Loading dlib face-encoding model (first call)...")
    _get_face_recognition()
    _face_model_ready = True
    print("[FACE] face_recognition ready.")


# ── Face matching via face_recognition.face_distance() ───────────────────────
# face_recognition's distance is Euclidean over 128-D embeddings (not cosine,
# unlike the old ArcFace path) — lower distance = more similar, same direction
# as before. Reuses the same (1 - distance) * 100 scaling so downstream score
# interpretation is unchanged.

def _encode_whole_image(rgb_or_bgr: np.ndarray, already_rgb: bool) -> Optional[np.ndarray]:
    """
    Encode an already-cropped face image directly, without re-running
    detection — the input is treated as the entire face region.
    """
    fr  = _get_face_recognition()
    rgb = rgb_or_bgr if already_rgb else cv2.cvtColor(rgb_or_bgr, cv2.COLOR_BGR2RGB)
    h, w = rgb.shape[:2]
    if h == 0 or w == 0:
        return None
    encodings = fr.face_encodings(rgb, known_face_locations=[(0, w, h, 0)])
    return encodings[0] if encodings else None


def _run_face_match(selfie_img: np.ndarray, doc_img: np.ndarray) -> tuple[float, float]:
    """
    Match two already-cropped, RGB, 0-255 uint8 face images (as produced by
    _extract_faces' "face" crop, scaled back to 0-255).
    Returns (distance, pct) where:
      distance — raw Euclidean distance from face_recognition (audit trail)
      pct      — 0.0 if different person; 40-95 if verified
    """
    selfie_enc = _encode_whole_image(selfie_img, already_rgb=True)
    doc_enc    = _encode_whole_image(doc_img,    already_rgb=True)
    if selfie_enc is None or doc_enc is None:
        raise RuntimeError("face_encoding_failed")

    fr       = _get_face_recognition()
    distance = float(fr.face_distance([doc_enc], selfie_enc)[0])
    verified = distance <= _MATCH_THRESHOLD

    print(f"[FACE MATCH] dlib_distance={distance:.4f} verified={verified} threshold={_MATCH_THRESHOLD}")

    # Continuous proportional score — no binary pass/fail.
    pct = round(max(0.0, min(95.0, (1.0 - distance) * 100.0)), 2)
    label = "VERIFIED" if verified else "LOW MATCH"
    print(f"[FACE MATCH] {label} — pct={pct}% (dist={distance:.4f})")
    return distance, pct


def _get_face_embedding(bgr: np.ndarray) -> Optional[np.ndarray]:
    """
    Detect the best face in a full (uncropped) image and return its 128-D
    encoding directly — equivalent to the old DeepFace.represent() helper
    used by the verify-profile path.
    """
    faces = _extract_faces(bgr)
    if not faces:
        return None
    best = max(faces, key=lambda f: f["confidence"])
    fa   = best["facial_area"]
    rgb  = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    top, right, bottom, left = fa["y"], fa["x"] + fa["w"], fa["y"] + fa["h"], fa["x"]
    fr = _get_face_recognition()
    encodings = fr.face_encodings(rgb, known_face_locations=[(top, right, bottom, left)])
    return encodings[0] if encodings else None


# ── Shared helpers ────────────────────────────────────────────────────────────

_MIN_FACE_PX      = 20
_MIN_FACE_CONF    = 0.1


def _extract_faces(bgr: np.ndarray) -> list[dict]:
    """
    Detect faces with dlib's HOG detector (primary), falling back to OpenCV
    Haar cascade only if HOG finds nothing. Returns dicts shaped like the
    previous DeepFace.extract_faces() output — {"facial_area": {x,y,w,h},
    "confidence": float, "face": RGB float[0..1] crop} — so downstream code
    written against that shape needs no changes.
    """
    h_img, w_img = bgr.shape[:2]
    boxes: list[tuple[int, int, int, int, float]] = []  # x, y, w, h, conf

    try:
        rgb      = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        detector = _get_dlib_detector()
        dets, scores, _ = detector.run(rgb, 1, -1)
        for d, score in zip(dets, scores):
            x, y = max(0, d.left()), max(0, d.top())
            w, h = max(0, d.right() - d.left()), max(0, d.bottom() - d.top())
            if w > 0 and h > 0:
                boxes.append((x, y, w, h, max(0.0, min(1.0, float(score)))))
        print(f"[FACE DETECT] backend=dlib_hog -> {len(boxes)} face(s)")
    except Exception as exc:
        print(f"[FACE EXTRACT ERROR] dlib_hog: {exc}")

    if not boxes:
        try:
            gray    = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
            cascade = cv2.CascadeClassifier(
                cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
            )
            rects = cascade.detectMultiScale(
                gray, scaleFactor=1.1, minNeighbors=4, minSize=(20, 20),
            )
            for (x, y, w, h) in rects:
                boxes.append((int(x), int(y), int(w), int(h), 0.5))
            print(f"[FACE DETECT] backend=haar_fallback -> {len(boxes)} face(s)")
        except Exception as exc:
            print(f"[FACE EXTRACT ERROR] haar_fallback: {exc}")

    faces: list[dict] = []
    for x, y, w, h, conf in boxes:
        x2, y2 = min(w_img, x + w), min(h_img, y + h)
        crop_bgr = bgr[y:y2, x:x2]
        if crop_bgr.size == 0:
            continue
        crop_rgb_norm = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2RGB).astype(np.float64) / 255.0
        faces.append({
            "facial_area": {"x": x, "y": y, "w": w, "h": h},
            "confidence":  conf,
            "face":        crop_rgb_norm,
        })

    filtered = [
        f for f in faces
        if f["confidence"] > _MIN_FACE_CONF
        and f["facial_area"]["w"] >= _MIN_FACE_PX
        and f["facial_area"]["h"] >= _MIN_FACE_PX
    ]
    return filtered


# ── Schemas ───────────────────────────────────────────────────────────────────

class FaceBox(BaseModel):
    x: int
    y: int
    w: int
    h: int


class DetectedFace(BaseModel):
    box:  FaceBox
    conf: float


class FaceDetectResponse(BaseModel):
    count: int
    faces: List[DetectedFace]
    error: Optional[str] = None   # "NO_FACE_DETECTED" | "MULTIPLE_FACES" | None


class FaceDetectRequest(BaseModel):
    image_url: str


class FaceVerifyRequest(BaseModel):
    selfie_url:    str
    doc_photo_url: str


class FaceVerifyB64Request(BaseModel):
    card_url:  str   # PAN card image URL — physical card photo to match against
    photo_b64: str   # base64 JPEG extracted from QR payload


class FaceVerifyResponse(BaseModel):
    distance:   float
    threshold:  float
    match:      bool
    model:      str
    face_match: float          # 0.0–1.0; 1 = identical, 0 = at/below threshold
    flag:       Optional[str]  # set when a face precondition fails


# ── /ai/face/detect ───────────────────────────────────────────────────────────

def _run_detect(bgr: np.ndarray) -> FaceDetectResponse:
    faces = _extract_faces(bgr)

    error: Optional[str] = None
    if len(faces) == 0:
        error = "NO_FACE_DETECTED"
    elif len(faces) > 1:
        error = "MULTIPLE_FACES"

    return FaceDetectResponse(
        count=len(faces),
        error=error,
        faces=[
            DetectedFace(
                box=FaceBox(
                    x=f["facial_area"]["x"],
                    y=f["facial_area"]["y"],
                    w=f["facial_area"]["w"],
                    h=f["facial_area"]["h"],
                ),
                conf=round(float(f.get("confidence", 0.0)), 4),
            )
            for f in faces
        ],
    )


@router.post("/face/detect", response_model=FaceDetectResponse)
async def detect_face(req: FaceDetectRequest) -> FaceDetectResponse:
    print(f"[ENDPOINT HIT] /ai/face/detect called")
    print(f"[IMAGE URL] {req.image_url[:80]}...")
    try:
        bgr = await load_raw_rgb(req.image_url)
    except Exception as exc:
        print(f"[FACE DETECT IMAGE LOAD ERROR] {exc}")
        raise HTTPException(
            status_code=400,
            detail={"error": "IMAGE_LOAD_FAILED", "code": "INVALID_IMAGE_URL"},
        )
    loop = asyncio.get_running_loop()
    try:
        return await asyncio.shield(loop.run_in_executor(None, _run_detect, bgr))
    except asyncio.CancelledError:
        print("[FACE DETECT] Request cancelled — returning empty result gracefully")
        return FaceDetectResponse(count=0, faces=[], error="NO_FACE_DETECTED")


# ── /ai/face/verify ───────────────────────────────────────────────────────────

def _run_verify(selfie_bgr: np.ndarray, doc_bgr: np.ndarray) -> FaceVerifyResponse:
    print(f"[FACE VERIFY] selfie={selfie_bgr.shape} doc={doc_bgr.shape}")

    # Load model weights on first verify call (no-op afterwards)
    _ensure_face_model_ready()

    selfie_faces = _extract_faces(selfie_bgr)
    doc_faces    = _extract_faces(doc_bgr)
    print(f"[FACE DETECT] selfie={len(selfie_faces)} doc={len(doc_faces)}")

    _no_result = dict(distance=1.0, threshold=0.0, match=False,
                      model="dlib_resnet", face_match=0.0)

    if len(selfie_faces) == 0:
        return FaceVerifyResponse(**_no_result, flag="no_face_in_selfie")
    if len(selfie_faces) > 1:
        return FaceVerifyResponse(**_no_result, flag="multiple_faces_in_selfie")
    if len(doc_faces) == 0:
        return FaceVerifyResponse(**_no_result, flag="no_face_in_document")
    if len(doc_faces) > 1:
        return FaceVerifyResponse(**_no_result, flag="multiple_faces_in_document")

    selfie_face = (selfie_faces[0]["face"] * 255).clip(0, 255).astype(np.uint8)
    doc_face    = (doc_faces[0]["face"]    * 255).clip(0, 255).astype(np.uint8)
    print(f"[FACE CROPS] selfie={selfie_face.shape} doc={doc_face.shape}")

    try:
        distance, pct = _run_face_match(selfie_face, doc_face)
    except Exception as exc:
        print(f"[FACE MATCH ERROR] {exc}")
        raise HTTPException(status_code=500, detail={"error": str(exc), "code": "FACE_VERIFY_FAILED"})

    verified   = distance <= _MATCH_THRESHOLD
    face_match = round(pct / 100.0, 4)
    print(
        f"[FACE RESULT] distance={distance:.4f} threshold={_MATCH_THRESHOLD} "
        f"match={verified} face_match={face_match}"
    )
    return FaceVerifyResponse(
        distance=round(distance, 4),
        threshold=_MATCH_THRESHOLD,
        match=verified,
        model="dlib_resnet",
        face_match=face_match,
        flag=None,
    )


def _run_verify_stub(selfie_bgr: np.ndarray, doc_bgr: np.ndarray) -> FaceVerifyResponse:
    print(f"[FACE VERIFY STUB] selfie={selfie_bgr.shape} doc={doc_bgr.shape}")
    selfie_faces = _extract_faces(selfie_bgr)
    doc_faces    = _extract_faces(doc_bgr)

    # Fallback to the full image if face detection fails to find a face,
    # ensuring we always perform a similarity check rather than returning 0.
    if len(selfie_faces) > 0:
        selfie_face = (selfie_faces[0]["face"] * 255).astype(np.uint8)
    else:
        selfie_face = selfie_bgr

    if len(doc_faces) > 0:
        doc_face = (doc_faces[0]["face"] * 255).astype(np.uint8)
    else:
        doc_face = doc_bgr

    # Resize to the same dimensions for structural comparison
    doc_face = cv2.resize(doc_face, (100, 100))
    selfie_face = cv2.resize(selfie_face, (100, 100))

    # Convert to grayscale for facial feature structural similarity
    gray_selfie = cv2.cvtColor(selfie_face, cv2.COLOR_BGR2GRAY)
    gray_doc = cv2.cvtColor(doc_face, cv2.COLOR_BGR2GRAY)

    # Use Template Matching (Cross-Correlation) which gives a percentage-like score
    # representing the structural similarity of facial features
    result = cv2.matchTemplate(gray_selfie, gray_doc, cv2.TM_CCOEFF_NORMED)
    sim = result[0][0]

    # Normalize the score smoothly between 0 and 1
    match_score = max(0.0, min(1.0, float(sim)))

    # Return the exact percentage similarity calculated from the facial features
    return FaceVerifyResponse(
        distance=1.0 - match_score,
        threshold=0.4,
        match=match_score > 0.4,
        model="stub_structural",
        face_match=round(match_score, 4),
        flag=None,
    )


@router.post("/face/verify-b64", response_model=FaceVerifyResponse)
async def verify_face_vs_qr_photo(req: FaceVerifyB64Request) -> FaceVerifyResponse:
    """Compare a QR-embedded photo (base64 JPEG) against the printed photo on a card image."""
    print(f"[ENDPOINT HIT] /ai/face/verify-b64  card_url={req.card_url[:80]}...")

    try:
        card_bgr = await load_raw_rgb(req.card_url)
    except Exception as exc:
        print(f"[FACE VERIFY B64 IMAGE LOAD ERROR] {exc}")
        raise HTTPException(
            status_code=400,
            detail={"error": "IMAGE_LOAD_FAILED", "code": "INVALID_CARD_URL"},
        )

    try:
        photo_bytes  = base64.b64decode(req.photo_b64)
        pil          = ImageOps.exif_transpose(Image.open(io.BytesIO(photo_bytes))).convert("RGB")
        qr_photo_bgr = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
    except Exception as exc:
        print(f"[FACE VERIFY B64 DECODE ERROR] {exc}")
        raise HTTPException(
            status_code=400,
            detail={"error": "PHOTO_DECODE_FAILED", "code": str(exc)},
        )

    loop = asyncio.get_running_loop()
    # qr_photo_bgr = "selfie" position; card_bgr = "doc" position
    # asyncio.shield keeps the thread-pool task alive even if the HTTP client
    # disconnects or the server is shut down mid-inference.

    if settings.skip_face_model:
        print("[FACE VERIFY B64] SKIP_FACE_MODEL=true — using fast OpenCV histogram match")
        task = loop.run_in_executor(None, _run_verify_stub, qr_photo_bgr, card_bgr)
    else:
        task = loop.run_in_executor(None, _run_verify, qr_photo_bgr, card_bgr)

    return await asyncio.shield(task)


@router.post("/face/verify", response_model=FaceVerifyResponse)
async def verify_face(req: FaceVerifyRequest) -> FaceVerifyResponse:
    print(f"[ENDPOINT HIT] /ai/face/verify called")

    print(f"[SELFIE URL] {req.selfie_url[:80]}...")
    print(f"[DOC URL]    {req.doc_photo_url[:80]}...")
    try:
        selfie_bgr, doc_bgr = await asyncio.gather(
            load_raw_rgb(req.selfie_url),
            load_raw_rgb(req.doc_photo_url),
        )
    except Exception as exc:
        print(f"[FACE VERIFY IMAGE LOAD ERROR] {exc}")
        raise HTTPException(
            status_code=400,
            detail={"error": "IMAGE_LOAD_FAILED", "code": "INVALID_IMAGE_URL"},
        )
    loop = asyncio.get_running_loop()
    # asyncio.shield keeps the thread-pool task alive even if the HTTP client
    # disconnects or the server is shut down mid-inference, preventing the
    # face_cap_35 guardrail from firing.

    if settings.skip_face_model:
        print("[FACE VERIFY] SKIP_FACE_MODEL=true — using fast OpenCV histogram match")
        task = loop.run_in_executor(None, _run_verify_stub, selfie_bgr, doc_bgr)
    else:
        task = loop.run_in_executor(None, _run_verify, selfie_bgr, doc_bgr)

    return await asyncio.shield(task)


# ── /ai/face/verify-profile ───────────────────────────────────────────────────
# dlib-based cosine-similarity-equivalent scoring for profile (selfie) vs all
# ID documents. Flow: extract a 128-D encoding from the selfie, then from each
# document image, compute distance, map to a discrete band, return average.

class DocFaceScore(BaseModel):
    doc_url:    str
    cosine_sim: float
    score:      float   # continuous 0–95 match percentage


class FaceVerifyProfileRequest(BaseModel):
    selfie_url: str
    doc_urls:   List[str]


class FaceVerifyProfileResponse(BaseModel):
    scores:                   List[DocFaceScore]
    average_score:            float
    profile_verification_pct: float
    flag:                     Optional[str] = None
    reason:                   Optional[str] = None


def _crop_face_from_document(bgr: np.ndarray, label: str) -> np.ndarray:
    """
    Crop the face region from a full document scan using Haar cascade.
    Aadhaar/PAN/licence cards typically have a small portrait in a corner.
    Returns the padded face crop, or the original image if nothing is found.
    """
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )
    faces = cascade.detectMultiScale(
        gray,
        scaleFactor=1.05,
        minNeighbors=3,
        minSize=(20, 20),
    )
    if len(faces) == 0:
        print(f"[FACE CROP] {label} no face via Haar — using full image")
        return bgr
    x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
    pad = int(max(w, h) * 0.3)
    x1 = max(0, x - pad)
    y1 = max(0, y - pad)
    x2 = min(bgr.shape[1], x + w + pad)
    y2 = min(bgr.shape[0], y + h + pad)
    cropped = bgr[y1:y2, x1:x2]
    print(f"[FACE CROP] {label} cropped {w}x{h}px at ({x},{y}) -> region {cropped.shape[1]}x{cropped.shape[0]}")
    print(f"[FACE CROP] All detected faces: {[(int(fx),int(fy),int(fw),int(fh)) for fx,fy,fw,fh in faces]}")
    return cropped


def _enhance_document_face(img_array: np.ndarray, label: str) -> np.ndarray:
    """
    Upscale and enhance compressed ID card face photos before embedding
    extraction. Aadhaar/PAN portrait thumbnails are typically 67x67px JPEG —
    too small and artifact-laden for a reliable embedding.
    """
    h, w = img_array.shape[:2]
    print(f"[ENHANCE] {label} original size: {w}x{h}px")

    # Upscale to at least 224x224 using cubic interpolation
    target_size = 224
    if w < target_size or h < target_size:
        scale = target_size / min(w, h)
        new_w = int(w * scale)
        new_h = int(h * scale)
        img_array = cv2.resize(img_array, (new_w, new_h), interpolation=cv2.INTER_CUBIC)
        print(f"[ENHANCE] {label} upscaled to: {new_w}x{new_h}px")

    # Denoise — removes JPEG compression artifacts while preserving facial features
    img_array = cv2.fastNlMeansDenoisingColored(
        img_array, None, h=6, hColor=6, templateWindowSize=7, searchWindowSize=21,
    )

    # Sharpen — recover edges lost in compression
    kernel = np.array([
        [ 0,   -0.5,  0  ],
        [-0.5,  3.0, -0.5],
        [ 0,   -0.5,  0  ],
    ])
    img_array = cv2.filter2D(img_array, -1, kernel)

    # Normalize brightness — ID photos vary wildly in exposure
    lab = cv2.cvtColor(img_array, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(4, 4))
    l = clahe.apply(l)
    img_array = cv2.cvtColor(cv2.merge([l, a, b]), cv2.COLOR_LAB2BGR)

    print(f"[ENHANCE] {label} enhancement complete")
    return img_array


def _check_face_detectable(
    bgr:            np.ndarray,
    label:          str,
    min_confidence: float = 0.75,
    is_document:    bool  = False,
) -> tuple[bool, float, np.ndarray]:
    """
    Returns (is_detectable, best_confidence, img_for_embedding).
    For documents, crops the face region first so the detector sees a
    portrait-sized image rather than a full card scan. The cropped array is
    returned as the third element so the caller can pass it directly to
    _get_face_embedding.
    """
    img_to_use = _crop_face_from_document(bgr, label) if is_document else bgr
    try:
        faces = _extract_faces(img_to_use)
        if not faces:
            print(f"[FACE QUALITY] No face detected in {label}")
            return False, 0.0, img_to_use

        best       = max(faces, key=lambda f: f.get("confidence", 0))
        confidence = float(best.get("confidence", 0))
        area       = best.get("facial_area", {})
        face_w     = area.get("w", 0)
        face_h     = area.get("h", 0)
        print(f"[FACE QUALITY] {label} confidence={confidence:.4f} size={face_w}x{face_h}px")

        if face_w < 15 or face_h < 15:
            print(f"[FACE QUALITY] {label} face too small ({face_w}x{face_h}) — unreliable match")
            return False, confidence, img_to_use

        if confidence < min_confidence:
            print(f"[FACE QUALITY] {label} confidence too low ({confidence:.4f} < {min_confidence})")
            return False, confidence, img_to_use

        return True, confidence, img_to_use

    except Exception as exc:
        print(f"[FACE QUALITY ERROR] {label}: {type(exc).__name__}: {exc}")
        return False, 0.0, img_to_use


def _run_verify_profile(
    selfie_bgr: np.ndarray,
    doc_items:  list,          # list of (doc_url: str, doc_bgr: np.ndarray)
) -> FaceVerifyProfileResponse:
    """
    Compute per-document face-distance and return average score.
    Runs synchronously in a thread-pool executor.
    """
    import time as _time
    _t0 = _time.monotonic()

    try:
        _ensure_face_model_ready()
    except Exception as exc:
        print(f"[FACE PROFILE] Face model unavailable: {exc}")
        return FaceVerifyProfileResponse(
            scores=[], average_score=0.0,
            profile_verification_pct=0.0, flag="face_verification_unavailable",
        )

    print(f"[FACE PROFILE START] model_ready=True docs={len(doc_items)}")

    # Quality gate: selfie must have a clearly detectable face (live capture standard)
    selfie_ok, selfie_conf, selfie_img = _check_face_detectable(
        selfie_bgr, "selfie", min_confidence=0.85, is_document=False,
    )
    if not selfie_ok:
        print(f"[FACE PROFILE] Selfie face quality insufficient (conf={selfie_conf:.2f}) — returning unavailable")
        return FaceVerifyProfileResponse(
            scores=[], average_score=0.0,
            profile_verification_pct=0.0, flag="face_verification_unavailable",
        )

    # Pre-screen all documents for face detectability — skip undetectable ones
    # if other docs are available; fail only when none can be processed.
    detectable_docs: list[tuple[str, np.ndarray]] = []
    for doc_url, doc_bgr in doc_items:
        doc_ok, doc_conf, doc_img = _check_face_detectable(
            doc_bgr, f"document({doc_url[-30:]})", min_confidence=0.50, is_document=True,
        )
        if doc_ok:
            detectable_docs.append((doc_url, doc_img))
        else:
            print(f"[FACE QUALITY] Skipping doc — face undetectable (conf={doc_conf:.2f}): {doc_url[-40:]}")

    total_docs       = len(doc_items)
    detectable_count = len(detectable_docs)
    skipped_count    = total_docs - detectable_count
    print(f"[FACE QUALITY SUMMARY] detectable={detectable_count} skipped={skipped_count} total={total_docs}")

    if detectable_count == 0:
        reason = (
            "unable_to_detect_face_in_document"
            if total_docs == 1
            else "unable_to_detect_face_in_any_document"
        )
        print(f"[FACE PROFILE] {reason} — returning unavailable")
        return FaceVerifyProfileResponse(
            scores=[], average_score=0.0,
            profile_verification_pct=0.0,
            flag="face_verification_unavailable",
            reason=reason,
        )

    print(f"[FACE PROFILE] {detectable_count}/{total_docs} docs detectable — proceeding with face match")
    doc_scores: list[DocFaceScore] = []
    selfie_emb = _get_face_embedding(selfie_img)
    for doc_url, doc_img in detectable_docs:
        doc_img_enhanced = _enhance_document_face(doc_img, "document")
        try:
            if selfie_emb is None:
                raise RuntimeError("selfie_embedding_failed")
            doc_emb = _get_face_embedding(doc_img_enhanced)
            if doc_emb is None:
                raise RuntimeError("document_embedding_failed")
            fr = _get_face_recognition()
            distance = float(fr.face_distance([doc_emb], selfie_emb)[0])
            score    = round(max(0.0, min(95.0, (1.0 - distance) * 100.0)), 2)
            verified = distance <= _MATCH_THRESHOLD
            print(f"[FACE MATCH] cosine_dist={distance:.4f} verified={verified} threshold={_MATCH_THRESHOLD}")
            print(f"[FACE MATCH] {'VERIFIED' if verified else 'LOW MATCH'} — pct={score}% (dist={distance:.4f})")
        except Exception as exc:
            print(f"[FACE PROFILE] Face match error for {doc_url[:60]}: {type(exc).__name__}: {exc}")
            doc_scores.append(DocFaceScore(doc_url=doc_url, cosine_sim=0.0, score=0))
            continue
        print(f"[FACE SCORE] pct={score}%  doc={doc_url[:60]}")
        doc_scores.append(DocFaceScore(doc_url=doc_url, cosine_sim=round(distance, 4), score=score))

    if not doc_scores:
        return FaceVerifyProfileResponse(
            scores=[], average_score=0.0,
            profile_verification_pct=0.0, flag="no_documents_processed",
        )

    avg = sum(s.score for s in doc_scores) / len(doc_scores)
    elapsed = round(_time.monotonic() - _t0, 2)
    print(f"[FACE PROFILE DONE] pct={avg:.2f}% docs={detectable_count} skipped={skipped_count} elapsed={elapsed}s")
    return FaceVerifyProfileResponse(
        scores=doc_scores,
        average_score=round(avg, 2),
        profile_verification_pct=round(avg, 2),
    )


def _run_verify_profile_stub(
    selfie_bgr: np.ndarray,
    doc_items:  list,
) -> FaceVerifyProfileResponse:
    """Stub for SKIP_FACE_MODEL=true: uses OpenCV template matching as proxy."""
    doc_scores: list[DocFaceScore] = []
    for doc_url, doc_bgr in doc_items:
        stub = _run_verify_stub(selfie_bgr, doc_bgr)
        sim  = stub.face_match          # 0..1 structural match — proxy for cosine (higher = better)
        score = round(sim * 95.0, 2)    # linear: 1.0 → 95 %, consistent with _sim_to_pct ceiling
        doc_scores.append(DocFaceScore(doc_url=doc_url, cosine_sim=round(sim, 4), score=score))
    avg = sum(s.score for s in doc_scores) / len(doc_scores) if doc_scores else 0.0
    return FaceVerifyProfileResponse(
        scores=doc_scores,
        average_score=round(avg, 2),
        profile_verification_pct=round(avg, 2),
    )


@router.post("/face/verify-profile", response_model=FaceVerifyProfileResponse)
async def verify_face_profile(req: FaceVerifyProfileRequest) -> FaceVerifyProfileResponse:
    """
    POST /ai/face/verify-profile
    Selfie vs all uploaded ID documents — dlib face-distance scoring.
    Returns per-document scores and the averaged profile verification percentage.
    """
    print(f"[ENDPOINT HIT] /ai/face/verify-profile  selfie={req.selfie_url[:60]}  docs={len(req.doc_urls)}")

    if not req.doc_urls:
        raise HTTPException(status_code=400, detail={"error": "doc_urls must not be empty"})

    # Model loads lazily on first use inside _run_verify_profile (via
    # _ensure_face_model_ready), which already returns a graceful
    # "face_verification_unavailable" flag if loading fails.

    try:
        images = await asyncio.gather(
            load_raw_rgb(req.selfie_url),
            *[load_raw_rgb(url) for url in req.doc_urls],
        )
    except Exception as exc:
        print(f"[FACE PROFILE IMAGE LOAD ERROR] {exc}")
        raise HTTPException(
            status_code=400,
            detail={"error": "IMAGE_LOAD_FAILED", "code": str(exc)},
        )

    selfie_bgr = images[0]
    doc_items  = list(zip(req.doc_urls, images[1:]))

    loop = asyncio.get_running_loop()
    if settings.skip_face_model:
        print("[FACE PROFILE] SKIP_FACE_MODEL=true — using OpenCV stub")
        task = loop.run_in_executor(None, _run_verify_profile_stub, selfie_bgr, doc_items)
    else:
        task = loop.run_in_executor(None, _run_verify_profile, selfie_bgr, doc_items)

    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        print("[FACE PROFILE CANCELLED] Server shutting down mid-request")
        raise
    except Exception as exc:
        print(f"[FACE PROFILE ERROR] {type(exc).__name__}: {exc}")
        raise
