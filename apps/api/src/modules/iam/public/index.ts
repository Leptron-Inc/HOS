/** P2 public interface (F-15): what other modules and the trusted entry points may use. */
export {
  CredentialError,
  CredentialVerifier,
  type CellRealm,
  type TrustedIssuer,
  type VerifiedCredential,
} from '../credential-verifier.js';
export {
  AuthorizationService,
  type Evaluation,
  type PrincipalState,
} from '../authorization.service.js';
export {
  IamService,
  ORGANIZATION_ADMINISTRATOR,
  type AssignmentView,
  type RoleView,
  type UserView,
} from '../iam.service.js';
export {
  hasPermission,
  PermissionDeniedError,
  requirePermission,
  runWithGrants,
} from './authorizer.js';
export {
  definePlatformIdentity,
  platformIdentity,
  PrincipalGrants,
  type AuthorizationTarget,
  type Grant,
  type PlatformIdentity,
} from './grants.js';
export {
  definePermissions,
  isAssignablePermission,
  isRegisteredPermission,
  permissionCatalogue,
  IAM_PERMISSIONS,
  type PermissionDefinition,
} from './permissions.js';
import { declareDataSubjectParticipant } from '../../security/public/index.js';

// P2 holds personal data about users (display name, identity-provider subject): it erases on request (E-34).
declareDataSubjectParticipant('iam', ['user']);

export {
  RoleAssignmentChanged,
  RoleChanged,
  UserCreated,
  UserSessionsRevoked,
  UserStatusChanged,
} from './events.js';
