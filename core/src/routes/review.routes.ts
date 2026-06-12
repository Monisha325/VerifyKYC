import { Router }      from 'express';
import { requireAuth, requireRole } from '../middleware/auth.middleware';
import { queue, evidenceBundle, claim, decide } from '../modules/review/review.controller';

const router = Router();

// All review routes: authenticated + REVIEWER or ADMIN
router.use(requireAuth);
router.use(requireRole('REVIEWER', 'ADMIN'));

router.get('/',                   queue);           // GET  /api/v1/review/
router.get('/:id',                evidenceBundle);  // GET  /api/v1/review/:id
router.post('/:id/claim',         claim);           // POST /api/v1/review/:id/claim
router.post('/:id/decision',      decide);          // POST /api/v1/review/:id/decision

export default router;
