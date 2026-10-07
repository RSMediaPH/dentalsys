// Cloud administration (run by DentalSys staff where the cloud database is reachable).
//   npm run cloud:admin -- invite-new-org
//   npm run cloud:admin -- invite-branch <org-id> <BRANCHCODE> "<Branch name>" [timezone]
//   npm run cloud:admin -- list
//   npm run cloud:admin -- revoke-node <node-id>
import { openCloudDb } from './server.js';
import { createInvite, listOrganizations, migrateCloud, revokeNode } from './store.js';

const [cmd, ...args] = process.argv.slice(2);
const sql = await openCloudDb();
try {
  await migrateCloud(sql);
  if (cmd === 'invite-new-org') {
    const { code } = await createInvite(sql, { kind: 'new_org' });
    console.log(`Connection code (valid 72 hours, single use): ${code}`);
    console.log('Give it to the clinic; on their existing server: npm run cloud:connect -- <cloud-url> <code>');
  } else if (cmd === 'invite-branch' && args.length >= 3) {
    const { code, branchId } = await createInvite(sql, { kind: 'join_branch', orgId: args[0]!, branchCode: args[1]!, branchName: args[2]!, timezone: args[3] });
    console.log(`New branch ${args[1]} created (${branchId}).`);
    console.log(`Connection code (valid 72 hours, single use, needs a FRESH server): ${code}`);
  } else if (cmd === 'list') {
    console.log(JSON.stringify(await listOrganizations(sql), null, 2));
  } else if (cmd === 'revoke-node' && args[0]) {
    console.log((await revokeNode(sql, args[0])) ? 'Revoked.' : 'No active node with that id.');
  } else {
    console.log('Commands: invite-new-org | invite-branch <org-id> <CODE> "<name>" [timezone] | list | revoke-node <node-id>');
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await sql.close();
}
