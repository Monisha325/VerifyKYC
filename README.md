# VeriKYC — AI-Powered KYC & Identity Verification Platform

An enterprise-grade digital KYC platform that verifies government-issued identity documents using AI, with mandatory human review oversight. No application is ever auto-approved.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14 + Tailwind CSS |
| Core API | Node.js + Express + Prisma ORM |
| AI Service | Python + FastAPI |
| Database | PostgreSQL on Neon |
| Storage | Cloudinary (signed direct-upload) |
| Auth | JWT (15 min) + Rotating Refresh Tokens (7 d) |

## Architecture

```
browser → Next.js (Vercel) → Express core (Render) → Neon PostgreSQL
                                   ↓
                          FastAPI AI service (Railway)
                                   ↓
                          Cloudinary (images only)
```

## Local Setup

### Prerequisites

- Node.js 18+
- Python 3.10+
- A Neon (or any PostgreSQL) database
- A Cloudinary account

### 1. Clone and configure environment

```bash
cp core/.env.example core/.env
cp frontend/.env.local.example frontend/.env.local
cp ai-service/.env.example ai-service/.env
# Edit each .env file and fill in real values
```

### 2. Install dependencies

```bash
# Core API
cd core && npm install

# Frontend
cd ../frontend && npm install

# AI Service
cd ../ai-service
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate
pip install -r requirements.txt
```

### 3. Run database migrations and seed

```bash
cd core
npx prisma migrate deploy
npx prisma db seed
```

### 4. Start all three services

```bash
# Terminal 1 — Core API (port 4000)
cd core && npm run dev

# Terminal 2 — Frontend (port 3000)
cd frontend && npm run dev

# Terminal 3 — AI Service (port 8000)
cd ai-service
.venv\Scripts\activate   # Windows
# source .venv/bin/activate  # macOS/Linux
uvicorn app.main:app --reload --port 8000
```

Open [http://localhost:3000](http://localhost:3000)

## Test Accounts (after seeding)

| Role | Email | Password |
|------|-------|----------|
| Applicant | applicant@verikyc.dev | Test@1234 |
| Reviewer | reviewer@verikyc.dev | Test@1234 |
| Admin | admin@verikyc.dev | Test@1234 |

## KYC Flow

1. Applicant registers and verifies email
2. Applicant uploads government ID (Aadhaar / PAN / Passport / Driving Licence) + selfie
3. AI pipeline runs: quality gate → OCR → authenticity → fraud detection → face match
4. Application routes to **PENDING_REVIEW** regardless of AI score
5. Human reviewer approves, rejects, or escalates
6. Applicant receives decision with reason codes

## Document Support

| Document | Validation |
|----------|-----------|
| Aadhaar | Verhoeff checksum on 12-digit UID |
| PAN | Regex `^[A-Z]{3}[ABCFGHLJPTK][A-Z]\d{4}[A-Z]$` |
| Passport | ICAO 9303 MRZ check-digit (7-3-1 weighting) |
| Driving Licence | QR, EXIF, template layout checks |

## Scoring

```
doc_confidence  = 0.40×auth + 0.35×(100−fraud) + 0.15×fields + 0.10×ocr
identity_score  = 0.25×name + 0.20×dob + 0.05×gender + 0.15×address + 0.35×face
overall_score   = 0.55×mean(doc_confidence) + 0.45×identity_score
```

Score bands are **hints for reviewers only** — nothing auto-approves.

## Deployment

| Service | Platform | Notes |
|---------|----------|-------|
| Frontend | Vercel | Set `BACKEND_URL` env var |
| Core API | Render | Set all `core/.env` vars |
| AI Service | Railway | Set `INTERNAL_TOKEN` |
| Database | Neon | Use pooled + direct URLs |

## Security Notes

- Refresh tokens stored as SHA-256 hash only — never the raw value
- Images go directly to Cloudinary — no image bytes pass through the core API
- Audit log is append-only — no UPDATE or DELETE on `AuditEvent` ever
- All sessions invalidated on refresh-token reuse detection (family revocation)

## Pre-Launch Deliverables

The following files in `assets/` are placeholder stubs and must be replaced before shipping:

- `assets/VeriKYC_KYC_Platform_Documentation.pdf.txt` — replace with the full product spec PDF (architecture, API reference, AI scoring formulas, deployment guide, security model)
- `assets/brand-guide.pdf.txt` — replace with the VeriKYC brand guide PDF (colors, typography, tone)

## License

Private — All rights reserved.
