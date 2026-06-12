import sys
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Default to empty string — missing token rejects all guarded requests with 401
    # rather than crashing the process before the health check can respond.
    internal_token:    str  = ""
    # Face recognition model name — override with FACE_MODEL env var
    face_model:        str  = "ArcFace"
    # Set SKIP_FACE_MODEL=true locally to skip heavy model download during dev
    skip_face_model:   bool = False
    # Path to the DER-encoded UIDAI offline public key certificate.
    # Override with UIDAI_CERT_PATH env var; set UIDAI_CERT_URL to fetch from alternate source.
    uidai_cert_path:   str  = ""   # empty → auto-locate relative to routers/certs/
    uidai_cert_url:    str  = "https://uidai.gov.in/images/uidai_offline_publickey_26022019.cer"

    model_config = {"env_file": ".env", "extra": "ignore"}


settings = Settings()

if not settings.internal_token:
    print(
        "[CONFIG] ⚠️  INTERNAL_TOKEN is not set. "
        "All guarded endpoints will return 401.",
        file=sys.stderr,
    )
