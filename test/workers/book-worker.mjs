// Worker threads don't inherit the tsx loader; register it, then load the TypeScript worker.
import { register } from 'tsx/esm/api';
register();
await import('./book-worker.ts');
