import express from 'express';
import cors from 'cors';
import teleportRouter from './routes/teleport.js';
import iopsRouter from './routes/iops.js';
import { cleanupAll } from './services/teleport.js';
import { closeSession } from './services/connection-manager.js';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

app.use('/api/teleport', teleportRouter);
app.use('/api/iops', iopsRouter);

app.listen(PORT, () => {
  console.log(`RDS IOP Killer server running on http://localhost:${PORT}`);
});

// Cleanup tunnels on process termination
async function shutdown(signal: string) {
  console.log(`\n[${signal}] Cleaning up...`);
  await closeSession();
  await cleanupAll();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
