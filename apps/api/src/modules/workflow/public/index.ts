/** workflow public interface (F-15): contracts plus the service other layers may use. */
export * from './contracts.js';
export {
  WorkflowService,
  type ApprovalView,
  type DefinitionView,
  type InstanceView,
} from '../workflow.service.js';
