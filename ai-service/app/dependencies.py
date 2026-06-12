from fastapi import Header, HTTPException, Depends
from app.config import settings


def verify_token(x_internal_token: str = Header(default="")) -> None:
    """Applied to every /ai/* endpoint. Rejects with 401 if header is missing or wrong."""
    if x_internal_token != settings.internal_token:
        raise HTTPException(status_code=401, detail={"error": "unauthorized"})
