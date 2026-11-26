/** documents public interface (F-15): contracts plus the service other layers may use. */
export * from './contracts.js';
export { DocumentService, type DocumentView } from '../document.service.js';
export {
  LocalEncryptedDocumentStorage,
  UnavailableDocumentStorage,
  type DocumentStorage,
} from '../document-storage.js';
