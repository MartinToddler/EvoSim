export { PROTOCOL_VERSION } from "./version";
export type { Envelope } from "./envelope";
export {
  type HostRuntimeConfig,
  DEFAULT_HOST_RUNTIME_CONFIG,
  HOST_RUNTIME_CONFIG_SCHEMA_VERSION,
} from "./hostRuntimeConfig";
export {
  validateHostRuntimeConfig,
  HostRuntimeConfigValidationError,
} from "./validateHostRuntimeConfig";
