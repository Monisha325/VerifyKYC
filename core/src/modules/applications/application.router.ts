import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth.middleware';
import { list, create, submit, getOne, getStatus, cancel, startLiveness, verifyLiveness } from './application.controller';
import { uploadParams, registerDoc } from '../documents/document.controller';
import documentRouter from '../documents/document.router';

const router = Router();

// All application routes require authentication
router.use(requireAuth);

router.get('/',                           list);
router.post('/',                          create);
router.post('/:id/uploads',               uploadParams);   // Step 1: get signed Cloudinary params
router.post('/:id/documents',             registerDoc);    // Step 2: register uploaded doc metadata
router.use('/:id/documents',              documentRouter); // replace-uploads + replace sub-routes
router.post('/:id/submit',                submit);
router.post('/:id/cancel',                cancel);
router.post('/:id/liveness/session',      startLiveness);
router.post('/:id/liveness',              verifyLiveness);
router.get('/:id',                        getOne);
router.get('/:id/status',                 getStatus);

export default router;
