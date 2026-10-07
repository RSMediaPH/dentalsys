// Runs in its own thread with its OWN database connection, like a second server process.
import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../../src/db/db.js';
import { buildContext } from '../../src/domain/context.js';
import { bookAppointment } from '../../src/domain/appointments.js';
import { AppError } from '../../src/lib/core.js';

const { dbFile, userId, membershipId, branchId, barrier, parties, input } = workerData;
const db = openDatabase(dbFile);
const ctx = buildContext(db, userId, membershipId, branchId)!;
// Wait until every worker is ready, then all book at once.
const flag = new Int32Array(barrier);
Atomics.add(flag, 0, 1);
while (Atomics.load(flag, 0) < parties) Atomics.wait(flag, 0, Atomics.load(flag, 0), 5);
let result = 'ok';
try {
  bookAppointment(ctx, input);
} catch (e) {
  result = e instanceof AppError ? e.code : `ERR ${(e as Error).message}`;
}
db.close();
parentPort!.postMessage(result);
