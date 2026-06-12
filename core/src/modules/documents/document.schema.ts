import { z } from 'zod';
import { DocKind } from '@prisma/client';

export const UploadParamsSchema = z.object({
  kind: z.nativeEnum(DocKind),
});

export const RegisterDocumentSchema = z.object({
  kind:      z.nativeEnum(DocKind),
  publicId:  z.string().min(1, 'publicId is required'),
  secureUrl: z
    .string()
    .url()
    .regex(/^https:\/\/res\.cloudinary\.com\//, 'secureUrl must be a Cloudinary delivery URL (res.cloudinary.com)'),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'sha256 must be a 64-char lowercase hex SHA-256 digest'),
});

export const ReplaceDocumentSchema = z.object({
  publicId:  z.string().min(1, 'publicId is required'),
  secureUrl: z
    .string()
    .url()
    .regex(/^https:\/\/res\.cloudinary\.com\//, 'secureUrl must be a Cloudinary delivery URL (res.cloudinary.com)'),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'sha256 must be a 64-char lowercase hex SHA-256 digest'),
});

export type UploadParamsDto     = z.infer<typeof UploadParamsSchema>;
export type RegisterDocumentDto = z.infer<typeof RegisterDocumentSchema>;
export type ReplaceDocumentDto  = z.infer<typeof ReplaceDocumentSchema>;
