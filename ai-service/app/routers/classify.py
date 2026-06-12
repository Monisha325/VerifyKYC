"""
POST /ai/classify

Identifies document type from OCR text using weighted keyword/anchor matching.
No image processing — caller passes text already extracted by /ai/ocr.

Input:
  { "ocr_text": str }           — raw concatenated text
  { "segments": [{text, ...}] } — ocr segments (text is joined)
  Either or both may be supplied; both are combined when present.

Output:
  { "doc_type": "AADHAAR"|"PAN"|"PASSPORT"|"DRIVING_LICENCE"|"UNKNOWN",
    "confidence": float,          0.0–1.0
    "matched_anchors": [str] }    anchors that fired
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.dependencies import verify_token

router = APIRouter(dependencies=[Depends(verify_token)])


# ── Anchor table ──────────────────────────────────────────────────────────────
# primary (weight 3): highly specific to that document type
# secondary (weight 1): useful supporting evidence, but appear elsewhere too

_ANCHORS: Dict[str, Dict[str, List[str]]] = {
    "AADHAAR": {
        "primary":   ["aadhaar", "aadhar", "uidai", "unique identification authority of india",
                      "enrolment no", "vid :"],
        "secondary": ["uid", "year of birth", "government of india"],
    },
    "PAN": {
        "primary":   ["permanent account number", "income tax department",
                      "income tax dept", "itd", "pan card"],
        "secondary": ["pan", "father's name", "father s name"],
    },
    "PASSPORT": {
        "primary":   ["passport", "republic of india", "passport no", "country code ind",
                      "place of birth"],
        "secondary": ["nationality", "given names", "surname", "date of issue", "date of expiry",
                      "personal no"],
    },
    "DRIVING_LICENCE": {
        "primary":   ["driving licence", "driving license", "dl no", "d.l. no",
                      "transport department"],
        "secondary": ["cov", "class of vehicle", "validity", "motor vehicle", "transport"],
    },
}

_PRIMARY_W  = 3
_SECONDARY_W = 1
# Minimum raw score to classify (avoids spurious 1-word matches)
_MIN_SCORE  = 2


# ── Schemas ───────────────────────────────────────────────────────────────────

class ClassifyRequest(BaseModel):
    ocr_text: Optional[str] = None
    segments: Optional[List[Dict[str, Any]]] = None


class ClassifyResponse(BaseModel):
    doc_type: str
    confidence: float
    matched_anchors: List[str]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _score(text_lower: str, anchors: Dict[str, List[str]]) -> tuple[int, List[str]]:
    hits: List[str] = []
    raw = 0
    for anchor in anchors.get("primary", []):
        if anchor in text_lower:
            hits.append(anchor)
            raw += _PRIMARY_W
    for anchor in anchors.get("secondary", []):
        if anchor in text_lower:
            hits.append(anchor)
            raw += _SECONDARY_W
    return raw, hits


def _classify(text: str) -> ClassifyResponse:
    cleaned = re.sub(r"\s+", " ", text.lower().strip())

    scores: Dict[str, int] = {}
    all_hits: Dict[str, List[str]] = {}
    for doc_type, anchors in _ANCHORS.items():
        s, hits = _score(cleaned, anchors)
        scores[doc_type] = s
        all_hits[doc_type] = hits

    best = max(scores, key=lambda k: scores[k])
    best_score = scores[best]

    if best_score < _MIN_SCORE:
        return ClassifyResponse(doc_type="UNKNOWN", confidence=0.0, matched_anchors=[])

    # Confidence: ratio of scored points to "3 primary hits" (a high-confidence bar)
    HIGH_BAR = _PRIMARY_W * 3
    confidence = round(min(1.0, best_score / HIGH_BAR), 4)

    # Scale down if the runner-up is close (ambiguous text)
    scores_sorted = sorted(scores.values(), reverse=True)
    if len(scores_sorted) > 1 and scores_sorted[1] >= best_score * 0.7:
        confidence = round(confidence * 0.6, 4)

    return ClassifyResponse(
        doc_type=best,
        confidence=confidence,
        matched_anchors=all_hits[best],
    )


# ── Endpoint ─────────────────────────────────────────────────────────────────

@router.post("/classify", response_model=ClassifyResponse)
async def classify_document(req: ClassifyRequest) -> ClassifyResponse:
    if not req.ocr_text and not req.segments:
        raise HTTPException(status_code=422, detail="Provide ocr_text or segments")

    parts: List[str] = []
    if req.ocr_text:
        parts.append(req.ocr_text)
    if req.segments:
        parts.extend(s.get("text", "") for s in req.segments if isinstance(s, dict))

    combined = " ".join(filter(None, parts))
    if not combined.strip():
        raise HTTPException(status_code=422, detail="No text content to classify")

    return _classify(combined)
