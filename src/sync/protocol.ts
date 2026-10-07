// The branch ↔ cloud wire contract, shared by both sides.
export const PROTOCOL_HEADER = 'x-dentalsys-protocol';
export const SUPPORTED_PROTOCOLS = [1] as const;
export const MAX_UPLOAD_BATCH = 200;
export const MAX_DOWNLOAD_PAGE = 500;

/** Shared patient record fields synchronized across branches (conflicts are detected per field). */
export const PATIENT_DEMOGRAPHIC_FIELDS = [
  'first_name', 'middle_name', 'last_name', 'sex', 'date_of_birth', 'phone', 'email', 'address',
  'emergency_contact_name', 'emergency_contact_phone', 'guardian_name', 'guardian_relationship', 'guardian_phone',
] as const;
export const PATIENT_MEDICAL_FIELDS = ['allergies', 'medications', 'medical_history'] as const;
export const PATIENT_FIELDS = [...PATIENT_DEMOGRAPHIC_FIELDS, ...PATIENT_MEDICAL_FIELDS] as const;
export type PatientField = (typeof PATIENT_FIELDS)[number];

/** Organization-level records replicated to every branch of the organization. */
export const ORG_ENTITY_TYPES = ['organization', 'branch', 'user', 'membership', 'service', 'operatory', 'dentist_schedule'] as const;
export type OrgEntityType = (typeof ORG_ENTITY_TYPES)[number];
export const isOrgEntityType = (t: string): t is OrgEntityType => (ORG_ENTITY_TYPES as readonly string[]).includes(t);

export interface WireEvent {
  id: string;
  org_id: string;
  branch_id: string;
  node_id: string;
  seq: number;
  entity_type: string;
  entity_id: string;
  op: string;
  entity_version: number | null;
  base_version: number | null;
  actor_user_id: string | null;
  payload: Record<string, unknown>;
  schema_version: number;
  app_version: string;
  created_at: string;
}

export type EventResult = { id: string; status: 'accepted' | 'duplicate' } | { id: string; status: 'rejected'; reason: string };

/** Change kinds distributed by the cloud to branches. */
export type ChangeKind = 'org.entity' | 'patient.state' | 'branch.fact' | 'conflict.opened' | 'conflict.resolved';

export interface WireChange {
  cursor: string; // bigint as string
  kind: ChangeKind;
  entity_type: string;
  entity_id: string;
  origin_branch_id: string | null;
  payload: Record<string, unknown>;
}

export interface BranchFreshness {
  branch_id: string;
  code: string;
  name: string;
  last_event_at: string | null;
  last_seen_at: string | null;
  app_version: string | null;
}

export interface ChangesResponse {
  changes: WireChange[];
  next_cursor: string;
  has_more: boolean;
  branches: BranchFreshness[];
  server_time: string;
}

export interface EnrollRequest {
  code: string;
  node_id: string;
  app_version: string;
  /** Sent when this server already has its organization (first branch of a new cloud organization). */
  organization?: { id: string; name: string };
  branch?: { id: string; code: string; name: string; timezone: string };
}

export interface EnrollResponse {
  kind: 'new_org' | 'join_branch';
  node_secret: string;
  org_id: string;
  branch_id: string;
  /** For join_branch: what the new server must create locally. */
  organization?: Record<string, unknown>;
  branch?: { id: string; code: string; name: string; timezone: string };
}
