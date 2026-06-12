import { Router }      from 'express';
import { requireAuth, requireRole } from '../middleware/auth.middleware';
import { getEntityHistory } from '../utils/audit';
import { AppError }     from '../middleware/errorHandler';

const router = Router();

// GET /api/v1/audit/:entity/:entityId — ADMIN only
// Returns the full time-ordered audit trail for one entity instance.
// Example: GET /api/v1/audit/KycApplication/clxxx123
router.get(
  '/:entity/:entityId',
  requireAuth,
  requireRole('ADMIN'),
  async (req, res) => {
    const { entity, entityId } = req.params;
    if (!entity || !entityId) throw new AppError(400, 'entity and entityId are required');
    const events = await getEntityHistory(entity, entityId);
    res.json({ entity, entityId, count: events.length, events });
  },
);

export default router;
