import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIG,
  ENGINE_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
} from "@eon/engine";
import { PROTOCOL_VERSION } from "@eon/protocol";

/**
 * Milestone 0/1 application shell.
 *
 * Deliberately empty of simulation, world and rendering — those arrive with
 * later milestones (worker in M6, renderer in M6, observation UI in M7). The
 * shell only proves the workspace wiring: the app consumes version constants
 * and config metadata straight from the pure engine package.
 */
export function App() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", margin: "2rem auto", maxWidth: "40rem" }}>
      <h1>Project EON</h1>
      <p>
        Deterministic artificial-life sandbox — engine determinism skeleton (Milestones 0–1). World
        generation, organisms and rendering arrive in later milestones.
      </p>
      <table>
        <tbody>
          <tr>
            <th scope="row" style={{ textAlign: "left", paddingRight: "1rem" }}>
              Engine version
            </th>
            <td>{ENGINE_VERSION}</td>
          </tr>
          <tr>
            <th scope="row" style={{ textAlign: "left", paddingRight: "1rem" }}>
              Protocol version
            </th>
            <td>{PROTOCOL_VERSION}</td>
          </tr>
          <tr>
            <th scope="row" style={{ textAlign: "left", paddingRight: "1rem" }}>
              Snapshot schema
            </th>
            <td>{SNAPSHOT_SCHEMA_VERSION}</td>
          </tr>
          <tr>
            <th scope="row" style={{ textAlign: "left", paddingRight: "1rem" }}>
              Config schema
            </th>
            <td>{CONFIG_SCHEMA_VERSION}</td>
          </tr>
          <tr>
            <th scope="row" style={{ textAlign: "left", paddingRight: "1rem" }}>
              Default world size
            </th>
            <td>
              {DEFAULT_CONFIG.world.sizeLU} × {DEFAULT_CONFIG.world.sizeLU} LU
            </td>
          </tr>
        </tbody>
      </table>
    </main>
  );
}
