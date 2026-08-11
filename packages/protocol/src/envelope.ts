/**
 * Generic protocol envelope (docs/02 §12).
 *
 * Hot binary render messages may use a specialized shape instead; everything
 * else travels wrapped in this envelope. The concrete command/message unions
 * (docs/02 §13–15) are delivered with Milestone 6 (task G01).
 */
export interface Envelope<T extends string, P> {
  protocolVersion: number;
  requestId?: number;
  type: T;
  payload: P;
}
