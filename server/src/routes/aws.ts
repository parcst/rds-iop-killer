import { Router, Request, Response } from 'express';
import { spawn, ChildProcess } from 'child_process';

const router = Router();

let activeSsoProc: ChildProcess | null = null;

/**
 * GET /api/aws/sso-status
 * Check if there's a valid AWS SSO session (cached access token).
 */
router.get('/sso-status', async (_req: Request, res: Response) => {
  try {
    const { getSsoAccessToken } = await import('../services/aws-rds.js');
    const token = await getSsoAccessToken();
    res.json({ loggedIn: !!token });
  } catch {
    res.json({ loggedIn: false });
  }
});

/**
 * POST /api/aws/sso-login
 * Start AWS SSO login (opens browser via default profile).
 * Fire-and-forget; client polls sso-status.
 */
router.post('/sso-login', async (_req: Request, res: Response) => {
  try {
    // Kill any existing SSO login process
    if (activeSsoProc) {
      activeSsoProc.kill();
      activeSsoProc = null;
    }

    // Use 'default' profile — it has the real sso_start_url configured.
    // stdio: 'inherit' lets aws cli open the browser directly.
    const proc = spawn('aws', ['sso', 'login', '--profile', 'default'], {
      stdio: 'inherit',
    });
    activeSsoProc = proc;

    proc.on('exit', () => { activeSsoProc = null; });
    proc.on('error', () => { activeSsoProc = null; });

    res.json({ started: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
