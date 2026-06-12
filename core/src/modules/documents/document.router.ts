import { Router } from 'express';
import { replaceUploadParams, replaceDocument } from './document.controller';

// Mounted at /:id/documents inside application.router — mergeParams exposes :id
const router = Router({ mergeParams: true });

router.post('/:docId/replace-uploads', replaceUploadParams);
router.post('/:docId/replace',         replaceDocument);

export default router;
