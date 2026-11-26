/** integration public interface (F-15): contracts plus the service other layers may use. */
export * from './contracts.js';
export { IntegrationService, type ConnectorInstanceView } from '../integration.service.js';
export type { SecretStore } from '../secret-store.js';
export { LocalEncryptedSecretStore, UnavailableSecretStore } from '../secret-store.js';
export { OutboundHttp, CircuitBreaker } from '../outbound-http.js';
