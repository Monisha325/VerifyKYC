# VeriKYC — Structural Conventions

This document defines the structural rules for this codebase. Follow them automatically. If you believe a rule needs to be broken, explain why before doing so.

---

## 1. No File-Per-Function

Group related functions, types, and handlers in the same file.

Only split into a new file if:
- The file grows beyond ~200–300 lines **and** the new content represents a genuinely separate concern, OR
- Two unrelated responsibilities are being mixed in one file

Do not create a new file just because a function is "different" from others in the file.

---

## 2. No Empty Scaffolding

Never create:
- Placeholder files
- Empty `__init__.py` or `index.ts` files for future use
- Folders with no real content
- Files with only comments or TODOs

Create a file only when it has production-ready code to put in it.

---

## 3. No Pure Re-Export Wrappers

Do not create a file whose only job is:

```ts
import foo from '../somewhere/foo';
export default foo;
```

Import directly from the source module. One indirection layer with no logic adds zero value and creates dead files.

---

## 4. Justify New Folders

Before creating a new folder:
1. Check if an existing folder can hold the new file by feature/domain
2. A new top-level folder requires at least 3 related files to justify its existence
3. Do not create folders purely to mirror a type category (e.g., `/helpers`, `/utils`, `/wrappers`) if the files can live in the feature folder they belong to

---

## 5. Co-locate by Feature, Not by Type

Prefer:
```
modules/applications/
  application.controller.ts
  application.service.ts
  application.router.ts
  application.schema.ts
```

Over:
```
controllers/application.controller.ts
services/application.service.ts
routes/application.routes.ts
schemas/application.schema.ts
```

The project already follows the feature-co-location pattern. Maintain it.

---

## 6. Default to No New File

Before adding any file, ask:

> "Can this logic live in an existing file without making it unwieldy?"

Default answer: **yes, it can**. Only create a new file if the answer is clearly no.

Valid reasons to create a new file:
1. Existing files cannot reasonably contain the logic
2. Understanding would become significantly harder
3. Modification would become significantly harder
4. Testing would become significantly harder

Invalid reasons (never sufficient on their own):
- Separation of concerns
- Single Responsibility Principle
- Clean architecture
- Future extensibility or reuse
- Industry best practices

---

## 7. End-of-Task Self-Check

At the end of every feature or task, before marking it complete, verify:

- [ ] Did this task add any empty files?
- [ ] Did this task add any unused exports?
- [ ] Did this task add any single-purpose wrapper files?
- [ ] Did this task create a folder with only one file?
- [ ] Did this task create a pure re-export?

If any answer is yes — clean it up before finishing.

---

## Preferred Files to Extend (not replace)

**Backend:**
`auth.service.ts` · `document.service.ts` · `ai.client.ts` · `identity.correlation.ts` · `scoring.ts` · `document.validators.ts` · `review.service.ts` · `application.service.ts`

**AI Service:**
`quality.py` · `aadhaar_quality.py` · `aadhaar_qr.py` · `pan_qr.py` · `face.py` · `tampering.py` · `ocr.py` · `liveness.py`

**Frontend:**
`useLivenessStateMachine.ts` · `useFaceDetection.ts` · `useCamera.ts` · `api.ts` · `upload.ts` · existing page components · existing UI components

---

## 8. Ownership Checks Belong in the Service Layer

Do not enforce per-user resource access as route middleware. Instead:

- Scope Prisma queries directly: `where: { id, userId }` — the wrong user gets a 404, not a 403
- Load the resource and compare: `if (resource.userId !== req.user!.sub) throw new AppError(403, ...)`
- Pass `req.user!.sub` and `req.user!.role` into the service function; let the service decide

Middleware cannot know whether a resource belongs to a user without loading it — that requires a DB call the service will make anyway. Doing the check twice wastes a query; doing it only in middleware skips the service's context entirely.

---

## Decision Tiebreakers

| Situation | Default |
|---|---|
| Splitting vs merging | Merge |
| Abstraction vs simplicity | Simplicity |
| Architecture vs practicality | Practicality |
| Future-proofing vs current need | Current need |
| New file vs extending existing | Extend existing |
