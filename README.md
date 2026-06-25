# VeriKYC — AI-Powered KYC & Identity Verification Platform

**Live:** https://verify-gti01295r-monishapatnana6-5579s-projects.vercel.app

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
| Email | Brevo Transactional Email API |
| Conversational AI | Google Gemini (`gemini-2.5-flash`) via `@google/genai` |
| Agent Protocol | Model Context Protocol (MCP) — `@modelcontextprotocol/sdk` |
| Rate Limiting | `express-rate-limit` backed by Upstash Redis |

## Architecture

```
browser → Next.js (Vercel) → Express core (Render) → Neon PostgreSQL
                                   ↓
                          FastAPI AI service (Render)
                                   ↓
                          Cloudinary (images only)
```

## Agentic AI Layer

The Agent Chat feature exposes a hybrid interface on top of the KYC platform:

- **Path A (Quick Actions)** — persistent button panel grouped by agent domain. Button clicks send an exact tool name directly to the orchestrator, bypassing the LLM entirely.
- **Path B (Free-text chat)** — natural language messages are sent to Gemini, which selects and calls tools in a loop (up to 6 rounds) before returning a conversational response.

Both paths converge at `dispatchTool()` — the single execution and RBAC enforcement point. The LLM can never bypass role checks.

### Three Agent Domains

| Domain | Agent | Tools |
|--------|-------|-------|
| Authentication | `auth-agent` | Register, login, verify email, password management, profile — available to all roles |
| KYC Agent | `kyc-agent` | Create application, upload documents, submit, check status — APPLICANT only |
| Members | `members-agent` | Review queue, evidence bundle, claim, decision, audit trail — REVIEWER + ADMIN; user management — ADMIN only |

### MCP Endpoints

Real MCP servers using `StreamableHTTPServerTransport` (stateless, one transport per request):

```
POST /api/v1/mcp/auth
POST /api/v1/mcp/kyc
POST /api/v1/mcp/members
```

## Local Setup

### Prerequisites

- Node.js 18+
- Python 3.10+
- A Neon (or any PostgreSQL) database
- A Cloudinary account
- A Google Gemini API key (for Agent Chat free-text)
- A Brevo account (for transactional email)

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

1. Applicant registers and verifies email (OTP via Brevo)
2. Applicant completes liveness check (camera challenge, anti-replay via `LivenessSession`)
3. Applicant uploads government ID (Aadhaar / PAN / Passport / Driving Licence) + selfie
4. AI pipeline runs: quality gate → OCR → authenticity → fraud detection → face match
5. Application routes to **PENDING_REVIEW** regardless of AI score
6. Human reviewer claims, reviews evidence, then approves, rejects, or escalates
7. Applicant receives decision with reason codes

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
| Frontend | Vercel | Set `NEXT_PUBLIC_API_URL` env var |
| Core API | Render | Set all `core/.env` vars in dashboard (`sync: false`) |
| AI Service | Render (Docker) | Set `INTERNAL_TOKEN` to match core |
| Database | Neon | Use pooled `DATABASE_URL` + `DIRECT_URL` for migrations |

## Security Notes

- Refresh tokens stored as SHA-256 hash only — never the raw value
- Refresh token family revocation on reuse detection — all sessions invalidated
- Images go directly to Cloudinary — no image bytes pass through the core API
- Audit log is append-only — no UPDATE or DELETE on `AuditEvent` ever
- Rate limits on all auth endpoints (Upstash Redis-backed in production)
- RBAC enforced at `dispatchTool()` — applies to both button clicks and LLM tool calls
- Auto-injected session fields (`userId`, `role`) always overwrite LLM-supplied values

## License

Private — All rights reserved.
