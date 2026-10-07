// Explicit permission codes and the default role bundles.
// docs/04-permissions.md mirrors this file; test/permissions.test.ts checks they agree.

export const PERMISSIONS = [
  'org.settings.manage',
  'branch.settings.manage',
  'staff.manage',
  'patient.view',
  'patient.view.all_branches',
  'patient.create',
  'patient.edit',
  'patient.medical.view',
  'patient.medical.edit',
  'patient.export',
  'patient.merge',
  'appointment.view',
  'appointment.manage',
  'schedule.manage',
  'billing.view',
  'invoice.draft',
  'invoice.issue',
  'invoice.void',
  'payment.record',
  'payment.reverse',
  'catalog.manage',
  'report.collections.view',
  'report.branch.view',
  'report.org.view',
  'audit.view',
  'backup.view',
  'backup.run',
  'clinical.view',
  'clinical.record',
  'inventory.view',
  'inventory.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ['owner', 'branch_manager', 'dentist', 'receptionist', 'inventory_staff'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Organization owner',
  branch_manager: 'Branch manager',
  dentist: 'Dentist',
  receptionist: 'Receptionist',
  inventory_staff: 'Inventory staff',
};

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: [
    'org.settings.manage', 'branch.settings.manage', 'staff.manage',
    'patient.view', 'patient.view.all_branches', 'patient.create', 'patient.edit', 'patient.medical.view',
    'patient.export', 'patient.merge',
    'appointment.view', 'appointment.manage', 'schedule.manage',
    'billing.view', 'invoice.draft', 'invoice.issue', 'invoice.void', 'payment.record', 'payment.reverse',
    'catalog.manage', 'report.collections.view', 'report.branch.view', 'report.org.view',
    'audit.view', 'backup.view', 'backup.run', 'inventory.view', 'inventory.manage',
  ],
  branch_manager: [
    'branch.settings.manage', 'staff.manage',
    'patient.view', 'patient.create', 'patient.edit', 'patient.merge',
    'appointment.view', 'appointment.manage', 'schedule.manage',
    'billing.view', 'invoice.draft', 'invoice.issue', 'invoice.void', 'payment.record', 'payment.reverse',
    'catalog.manage', 'report.collections.view', 'report.branch.view',
    'audit.view', 'backup.view', 'backup.run', 'inventory.view', 'inventory.manage',
  ],
  dentist: [
    'patient.view', 'patient.create', 'patient.edit', 'patient.medical.view', 'patient.medical.edit',
    'appointment.view', 'appointment.manage',
    'billing.view', 'invoice.draft',
    'clinical.view', 'clinical.record',
  ],
  receptionist: [
    'patient.view', 'patient.create', 'patient.edit',
    'appointment.view', 'appointment.manage',
    'billing.view', 'invoice.draft', 'invoice.issue', 'payment.record',
    'report.collections.view',
  ],
  inventory_staff: ['inventory.view', 'inventory.manage'],
};

export const permissionsFor = (role: Role): Set<Permission> => new Set(ROLE_PERMISSIONS[role]);
