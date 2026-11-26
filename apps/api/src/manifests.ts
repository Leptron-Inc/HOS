import { AUDIT_KERNEL_MANIFEST, EVENTING_KERNEL_MANIFEST } from './kernel/kernel.manifests.js';
import type { ModuleManifest } from './kernel/database/public.js';
import { IAM_MANIFEST } from './modules/iam/iam.manifest.js';
import { TENANCY_MANIFEST } from './modules/tenancy/tenancy.manifest.js';
import { WORKFLOW_MANIFEST } from './modules/workflow/workflow.manifest.js';
import { CONFIGURATION_MANIFEST } from './modules/configuration/configuration.manifest.js';
import { SECURITY_MANIFEST } from './modules/security/security.manifest.js';
import { INTEGRATION_MANIFEST } from './modules/integration/integration.manifest.js';
import { DOCUMENTS_MANIFEST } from './modules/documents/documents.manifest.js';

/** Every table manifest in the cell; the catalog test compares this with the database (B-06, H-MIG-04). */
export const ALL_MANIFESTS: readonly ModuleManifest[] = [
  TENANCY_MANIFEST,
  IAM_MANIFEST,
  WORKFLOW_MANIFEST,
  CONFIGURATION_MANIFEST,
  SECURITY_MANIFEST,
  INTEGRATION_MANIFEST,
  DOCUMENTS_MANIFEST,
  AUDIT_KERNEL_MANIFEST,
  EVENTING_KERNEL_MANIFEST,
];
