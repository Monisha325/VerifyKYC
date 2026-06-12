import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { prisma } from '../utils/prisma';
import { AppError } from '../middleware/errorHandler';

const router = Router();
router.use(requireAuth);

// GET /api/v1/documents/:id — fetch a document with extracted fields + verification
router.get('/:id', async (req, res) => {
  const doc = await prisma.document.findUnique({
    where:   { id: req.params.id },
    include: {
      extractedFields:      true,
      documentVerification: true,
      application:          { select: { userId: true } },
    },
  });
  if (!doc) throw new AppError(404, 'Document not found');
  if (req.user!.role === 'APPLICANT' && doc.application.userId !== req.user!.sub) {
    throw new AppError(403, 'Access denied');
  }
  res.json(doc);
});

export default router;
