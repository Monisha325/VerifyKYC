import { clsx, type ClassValue } from 'clsx';
import { twMerge }               from 'tailwind-merge';
import type { AppStatus, DocStatus, DocKind } from './types';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: string | null | undefined): string {
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(new Date(date));
}

// ── Score helpers ─────────────────────────────────────────────────────────────

export function boostScore(score: number | null | undefined): number | null {
  if (score == null) return null;
  return Math.round(score);
}

export function scoreTextColor(score: number | null | undefined): string {
  if (score == null) return 'text-gray-400';
  if (score >= 70) return 'text-emerald-600';
  if (score >= 40) return 'text-amber-600';
  return 'text-rose-600';
}

export function scoreBarColor(score: number | null | undefined): string {
  if (score == null) return 'bg-gray-300';
  if (score >= 70) return 'bg-emerald-500';
  if (score >= 40) return 'bg-amber-500';
  return 'bg-rose-500';
}

export function scoreBandLabel(band: string | null | undefined, score: number | null | undefined): string {
  if (band) return band.replace('_', ' ');
  if (score == null) return 'Not scored';
  if (score >= 70) return 'FAST TRACK';
  if (score >= 40) return 'STANDARD';
  return 'FLAGGED';
}

// ── Status display maps ───────────────────────────────────────────────────────

export const APP_STATUS_LABEL: Record<AppStatus, string> = {
  DRAFT:          'Draft',
  SUBMITTED:      'Submitted',
  PROCESSING:     'Processing',
  PENDING_REVIEW: 'Under Review',
  APPROVED:       'Approved',
  REJECTED:       'Rejected',
};

export const APP_STATUS_COLOR: Record<AppStatus, string> = {
  DRAFT:          'bg-gray-100 text-gray-600',
  SUBMITTED:      'bg-blue-100 text-blue-700',
  PROCESSING:     'bg-amber-100 text-amber-700',
  PENDING_REVIEW: 'bg-amber-100 text-amber-700',
  APPROVED:       'bg-emerald-100 text-emerald-700',
  REJECTED:       'bg-rose-100 text-rose-700',
};

export const DOC_STATUS_LABEL: Record<DocStatus, string> = {
  UPLOADED:     'Uploaded',
  QUEUED:       'Queued',
  PROCESSING:   'Processing',
  VERIFIED:     'Verified',
  NEEDS_REVIEW: 'Under Review',
  FAILED:       'Failed',
};

export const DOC_STATUS_COLOR: Record<DocStatus, string> = {
  UPLOADED:     'bg-blue-100 text-blue-700',
  QUEUED:       'bg-gray-100 text-gray-500',
  PROCESSING:   'bg-amber-100 text-amber-700',
  VERIFIED:     'bg-emerald-100 text-emerald-700',
  NEEDS_REVIEW: 'bg-amber-100 text-amber-700',
  FAILED:       'bg-rose-100 text-rose-700',
};

export const DOC_KIND_LABEL: Record<DocKind, string> = {
  AADHAAR:         'Aadhaar Card',
  PAN:             'PAN Card',
  PASSPORT:        'Passport',
  DRIVING_LICENCE: 'Driving Licence',
  SELFIE:          'Selfie',
};
