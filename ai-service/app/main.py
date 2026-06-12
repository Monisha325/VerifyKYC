import sys
import ssl

# Bypass local Windows/Mac SSL certificate errors globally
try:
    ssl._create_default_https_context = ssl._create_unverified_context
except AttributeError:
    pass

# Force UTF-8 stdout/stderr so Unicode from libraries (tqdm, EasyOCR, torch)
# doesn't crash the process on Windows cp1252 consoles.
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if sys.stderr.encoding and sys.stderr.encoding.lower() != "utf-8":
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from dotenv import load_dotenv
load_dotenv()  # load ai-service/.env before any module reads os.getenv()

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError

from app.routers import quality, ocr, classify, tampering, face, qr_exif, aadhaar_quality, aadhaar_qr, pan_qr, liveness

# Heavy models (EasyOCR, DeepFace/ArcFace) are loaded lazily via importlib
# on the first request that needs them.  This keeps startup memory well under
# 512 MB so Railway's health check passes before any model touches the heap.

app = FastAPI(
    title="VeriKYC AI Service",
    description="Stateless image analysis: quality, OCR, classify, tampering, face.",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # server-to-server only — internal token guards every endpoint
    allow_credentials=False,
    allow_methods=["POST", "GET"],
    allow_headers=["Content-Type", "X-Internal-Token"],
)


# ── Global exception handlers ─────────────────────────────────────────────────
# Ensures every error returns JSON — never an HTML error page.

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content={"error": str(exc), "code": "INTERNAL_ERROR"},
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={"error": "validation_error", "details": exc.errors()},
    )


# ── Startup: warm up EasyOCR so the first real document call is never cold ────
# Runs in a background thread — health check passes immediately, model loads
# in the background over the next 60-120 s.

@app.on_event("startup")
async def _print_routes() -> None:
    for route in app.routes:
        methods = getattr(route, "methods", None)
        path    = getattr(route, "path",    None)
        if methods and path:
            print(f"[ROUTE] {methods} {path}")


@app.on_event("startup")
async def _warmup() -> None:
    import threading
    import asyncio as _asyncio
    import os as _os
    import numpy as _np
    from app.config import settings
    from app.routers import face as _face_mod

    # EasyOCR — background thread so it doesn't delay startup or health checks
    def _load_ocr() -> None:
        try:
            from app.routers.ocr import _get_reader
            print("[WARMUP] Loading EasyOCR reader (background)…")
            _get_reader(("en",))
            print("[WARMUP] EasyOCR ready.")
        except Exception as exc:
            print(f"[WARMUP] EasyOCR load failed: {exc}")
    threading.Thread(target=_load_ocr, daemon=True).start()

    # ArcFace — blocks startup so uvicorn only reaches "Application startup complete"
    # after the model is fully loaded. No request can arrive before model is ready.
    _weights = _os.path.expanduser("~/.deepface/weights/")
    _cached = (
        _os.path.exists(_weights)
        and any("arcface" in f.lower() for f in _os.listdir(_weights))
    )
    print(f"[WARMUP] ArcFace cached on disk: {_cached}")

    if not settings.skip_face_model:
        print("[WARMUP] Loading ArcFace model — server will not accept requests until ready...")

        def _load_arcface() -> None:
            from deepface import DeepFace as _DeepFace
            _DeepFace.represent(
                img_path=_np.zeros((112, 112, 3), dtype=_np.uint8),
                model_name="ArcFace",
                enforce_detection=False,
            )
            _face_mod._deepface_module = _DeepFace
            _face_mod._arcface_ready   = True
            print("[WARMUP] ArcFace model ready ✓ — server now accepting requests")

        try:
            await _asyncio.get_running_loop().run_in_executor(None, _load_arcface)
        except Exception as exc:
            print(f"[WARMUP] ArcFace load failed: {exc}")
        finally:
            _face_mod._arcface_event.set()   # in event loop — direct call, no call_soon_threadsafe
    else:
        print("[WARMUP] SKIP_FACE_MODEL=true — skipping ArcFace warmup")
        _face_mod._arcface_event.set()


@app.on_event("shutdown")
async def shutdown_event() -> None:
    import asyncio as _asyncio
    print("[SHUTDOWN] AI service shutting down — waiting for active requests to complete...")
    await _asyncio.sleep(2)
    print("[SHUTDOWN] Done")


# ── Health check — no auth guard, no model loading ────────────────────────────

@app.get("/health", tags=["Health"])
def health() -> dict:
    return {"status": "ok", "service": "verikyc-ai"}


# ── Routers — all /ai/* endpoints carry the X-Internal-Token guard ────────────

app.include_router(quality.router,   prefix="/ai", tags=["Quality"])
app.include_router(ocr.router,       prefix="/ai", tags=["OCR"])
app.include_router(classify.router,  prefix="/ai", tags=["Classify"])
app.include_router(tampering.router, prefix="/ai", tags=["Tampering"])
app.include_router(face.router,      prefix="/ai", tags=["Face"])
app.include_router(qr_exif.router,          prefix="/ai", tags=["QR-EXIF"])
app.include_router(aadhaar_quality.router,  prefix="/ai", tags=["Aadhaar-Quality"])
app.include_router(aadhaar_qr.router,       prefix="/ai", tags=["Aadhaar-QR"])
app.include_router(pan_qr.router,           prefix="/ai", tags=["PAN-QR"])
app.include_router(liveness.router,         prefix="/ai", tags=["Liveness"])
