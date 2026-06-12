import { Request, Response } from 'express';
import { UploadParamsSchema, RegisterDocumentSchema, ReplaceDocumentSchema } from './document.schema';
import { generateUploadParams, registerDocument, generateReplaceUploadParams, replaceFailedDocument } from './document.service';
import { enqueueSingleDocument } from '../verification/orchestrator';

export async function uploadParams(req: Request, res: Response) {
  const dto = UploadParamsSchema.parse(req.body);
  const params = await generateUploadParams(req.params.id, req.user!.sub, dto);
  res.json(params);
}

export async function registerDoc(req: Request, res: Response) {
  const dto = RegisterDocumentSchema.parse(req.body);
  const doc = await registerDocument(req.params.id, req.user!.sub, dto);
  res.status(201).json(doc);
}

export async function replaceUploadParams(req: Request, res: Response) {
  const params = await generateReplaceUploadParams(req.params.id, req.user!.sub, req.params.docId);
  res.json(params);
}

export async function replaceDocument(req: Request, res: Response) {
  const dto    = ReplaceDocumentSchema.parse(req.body);
  const newDoc = await replaceFailedDocument(req.user!.sub, req.params.id, req.params.docId, dto);
  enqueueSingleDocument(req.params.id, newDoc.id);   // fire and forget
  res.status(201).json(newDoc);
}
