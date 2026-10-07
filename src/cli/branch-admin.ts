// Branch setup from the command line (until the staff/settings screens exist). Changes sync to all branches.
//   npm run branch:admin -- list
//   npm run branch:admin -- add-chair "Chair 2"
//   npm run branch:admin -- add-staff <email> "<Display name>" <role> <password>
//   npm run branch:admin -- assign <email>                    (give an existing staff member access to this branch)
//   npm run branch:admin -- dentist-hours <email> <weekdays e.g. 1-6> <HH:MM> <HH:MM>
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, PROJECT_ROOT } from '../config.js';
import { openDatabase } from '../db/db.js';
import { ROLES, type Role } from '../auth/permissions.js';
import { addDentistBlock, assignStaffToBranch, createOperatory, createStaff } from '../domain/orgs.js';

if (fs.existsSync(path.join(PROJECT_ROOT, '.env'))) process.loadEnvFile(path.join(PROJECT_ROOT, '.env'));
const db = openDatabase(loadConfig().dbFile);
const [cmd, ...a] = process.argv.slice(2);
const branchId = (db.prepare(`SELECT value FROM sync_state WHERE key = 'branch_id'`).pluck().get() as string | undefined)
  ?? (db.prepare('SELECT id FROM branches ORDER BY created_at LIMIT 1').pluck().get() as string | undefined);
const branch = branchId ? (db.prepare('SELECT * FROM branches WHERE id = ?').get(branchId) as { id: string; org_id: string; code: string; name: string }) : null;
const hhmm = (s: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s); if (!m) throw new Error(`Bad time ${s}`); return Number(m[1]) * 60 + Number(m[2]); };
const membershipOf = (email: string) => {
  const m = db.prepare(`SELECT m.id, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE lower(u.email) = lower(?) AND m.org_id = ?`).get(email, branch!.org_id) as { id: string; role: Role } | undefined;
  if (!m) throw new Error(`No staff member ${email} in this organization`);
  return m;
};

try {
  if (!branch) throw new Error('This server has no branch yet. Seed demo data or connect it to the cloud first.');
  switch (cmd) {
    case 'list': {
      console.log(`Branch ${branch.code} — ${branch.name}`);
      console.log('Chairs:', (db.prepare('SELECT name FROM operatories WHERE branch_id = ? AND is_active = 1').pluck().all(branch.id) as string[]).join(', ') || 'none');
      const staff = db.prepare(`SELECT u.email, m.role, EXISTS (SELECT 1 FROM membership_branches mb WHERE mb.membership_id = m.id AND mb.branch_id = ?) OR m.role = 'owner' AS here
                                FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.is_active = 1 ORDER BY m.role`).all(branch.id, branch.org_id) as { email: string; role: string; here: number }[];
      for (const s of staff) console.log(`  ${s.here ? '✓' : ' '} ${s.email} (${s.role})`);
      break;
    }
    case 'add-chair':
      createOperatory(db, branch.org_id, branch.id, a[0] ?? 'Chair');
      console.log('Chair added.');
      break;
    case 'add-staff': {
      const [email, name, role, password] = a;
      if (!email || !name || !ROLES.includes(role as Role) || !password) throw new Error(`Usage: add-staff <email> "<name>" <${ROLES.join('|')}> <password>`);
      await createStaff(db, { orgId: branch.org_id, email, displayName: name, role: role as Role, password, branchIds: role === 'owner' ? [] : [branch.id] });
      console.log('Staff member added to this branch.');
      break;
    }
    case 'assign':
      assignStaffToBranch(db, membershipOf(a[0] ?? '').id, branch.id);
      console.log('Assigned to this branch.');
      break;
    case 'dentist-hours': {
      const m = membershipOf(a[0] ?? '');
      if (m.role !== 'dentist') throw new Error('That staff member is not a dentist.');
      const [from, to] = (a[1] ?? '').split('-').map(Number);
      for (let wd = from!; wd <= (to ?? from!); wd++) addDentistBlock(db, branch.org_id, branch.id, m.id, wd, hhmm(a[2] ?? ''), hhmm(a[3] ?? ''));
      console.log('Working hours added.');
      break;
    }
    default:
      console.log('Commands: list | add-chair "<name>" | add-staff <email> "<name>" <role> <password> | assign <email> | dentist-hours <email> <1-6> <09:00> <18:00>');
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  db.close();
}
