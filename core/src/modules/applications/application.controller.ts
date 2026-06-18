import { Request, Response } from 'express';
import {
  createApplication,
  listApplications,
  submitApplication,
  getApplication,
  cancelApplication,
  createLivenessSession,
  completeLivenessSession,
} from './application.service';
import { enqueueApplication } from '../verification/orchestrator';

export async function list(req: Request, res: Response) {
  const apps = await listApplications(req.user!.sub);
  res.json(apps);
}

export async function create(req: Request, res: Response) {
  const app = await createApplication(req.user!.sub);
  res.status(201).json(app);
}

export async function submit(req: Request, res: Response) {
  const result = await submitApplication(req.params.id, req.user!.sub);
  // Fire-and-forget: return 202 first, then process asynchronously.
  // setImmediate defers after the current I/O cycle, giving Express time to flush the response.
  setImmediate(() => enqueueApplication(req.params.id));
  res.status(202).json(result);
}

export async function getOne(req: Request, res: Response) {
  const app = await getApplication(req.params.id, req.user!.sub, req.user!.role);
  res.json(app);
}

export async function getStatus(req: Request, res: Response) {
  const app = await getApplication(req.params.id, req.user!.sub, req.user!.role);
  res.json({ id: app.id, status: app.status, updatedAt: app.updatedAt });
}

export async function cancel(req: Request, res: Response) {
  const result = await cancelApplication(req.user!.sub, req.params.id);
  res.json(result);
}

export async function startLiveness(req: Request, res: Response) {
  const result = await createLivenessSession(req.params.id, req.user!.sub);
  res.status(201).json(result);
}

export async function verifyLiveness(req: Request, res: Response) {
  const { sessionId, snapshots } = req.body as { sessionId?: string; snapshots?: string[] };
  const result = await completeLivenessSession(req.params.id, req.user!.sub, sessionId ?? '', snapshots ?? []);
  res.json(result);
}
