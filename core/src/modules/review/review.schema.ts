import { z } from 'zod';
import { Decision } from '@prisma/client';

// Reviewer-selectable reason codes — at least one required per decision.
export const REASON_CODES = [
  // Approval
  'GENUINE_DOCS',
  'IDENTITY_CONFIRMED',
  'FACE_MATCH_PASSED',
  // Rejection
  'FRAUD_SUSPECTED',
  'DOCS_TAMPERED',
  'IDENTITY_MISMATCH',
  'DUPLICATE_APPLICATION',
  'INCOMPLETE_DOCS',
  // Escalation
  'NEEDS_SENIOR_REVIEW',
  'EDGE_CASE',
  'POLICY_EXCEPTION',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export const DecisionSchema = z.object({
  decision:    z.nativeEnum(Decision),
  reasonCodes: z
    .array(z.enum(REASON_CODES))
    .min(1, 'At least one reason code is required'),
  notes: z.string().max(2000).optional(),
});

export type DecisionDto = z.infer<typeof DecisionSchema>;
