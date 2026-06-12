import { Request, Response } from 'express';
import { DecisionSchema }    from './review.schema';
import {
  getQueue,
  getEvidenceBundle,
  claimApplication,
  recordDecision,
} from './review.service';

export async function queue(req: Request, res: Response) {
  const items = await getQueue();
  res.json({ count: items.length, items });
}

export async function evidenceBundle(req: Request, res: Response) {
  const bundle = await getEvidenceBundle(req.params.id);
  res.json(bundle);
}

export async function claim(req: Request, res: Response) {
  const result = await claimApplication(req.params.id, req.user!.sub);
  res.json(result);
}

export async function decide(req: Request, res: Response) {
  const dto    = DecisionSchema.parse(req.body);
  const result = await recordDecision(req.params.id, req.user!.sub, req.user!.role, dto);
  res.status(201).json(result);
}
