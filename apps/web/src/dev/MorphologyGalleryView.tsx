import { useEffect, useMemo, useRef, useState } from "react";
import { MorphologyGallery } from "@eon/renderer";
import { MorphGene } from "@eon/engine";
import {
  buildLineage,
  buildLocusSweep,
  buildRadiation,
  locusOptions,
  type GalleryBody,
} from "./morphologyGallery";
import "./devView.css";

/**
 * Morphology gallery (M14, docs/11 §M14).
 *
 * A debug screen at `?view=morphology`. It exists to make one claim checkable
 * without watching a world for an hour: the bodies the engine grows are
 * genetically inherited, continuously variable, and drawn by the production
 * path. Every body is developed by the engine's own interpreter and painted by
 * `paintMorphology` — the same function the detail layer calls, fed the same
 * channel bytes a render snapshot carries.
 *
 * No simulation runs here, and nothing on this screen can affect one.
 */

const CELL_PX = 160;
const COLUMNS = 6;
const BACKGROUND = 0x0b0f14;

type Mode = "radiation" | "lineage" | "locus";

export function MorphologyGalleryView() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const galleryRef = useRef<MorphologyGallery | null>(null);

  const [mode, setMode] = useState<Mode>("radiation");
  const [seed, setSeed] = useState(0xe0a12026);
  const [generations, setGenerations] = useState(400);
  const [gene, setGene] = useState<MorphGene>(MorphGene.BodyLength);

  const bodies = useMemo<GalleryBody[]>(() => {
    if (mode === "lineage") {
      return buildLineage(seed, 11, Math.max(1, Math.round(generations / 11)));
    }
    if (mode === "locus") {
      return buildLocusSweep(gene, 12);
    }
    return buildRadiation(seed, 12, generations);
  }, [mode, seed, generations, gene]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    let disposed = false;
    void MorphologyGallery.create({
      host,
      cellPx: CELL_PX,
      columns: COLUMNS,
      background: BACKGROUND,
    }).then((gallery) => {
      if (disposed) {
        gallery.destroy();
        return;
      }
      galleryRef.current = gallery;
      gallery.draw(bodies.map((body) => body.channels));
    });
    return () => {
      disposed = true;
      galleryRef.current?.destroy();
      galleryRef.current = null;
    };
    // Mounted once; redraws are the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    galleryRef.current?.draw(bodies.map((body) => body.channels));
  }, [bodies]);

  return (
    <div className="dev-view">
      <header className="dev-view__header">
        <h1>Morphology gallery</h1>
        <p>
          Bodies developed by the engine&rsquo;s own interpreter and painted by the production
          renderer path (M14). No simulation runs on this screen.
        </p>
      </header>

      <div className="dev-view__controls">
        <label>
          View
          <select value={mode} onChange={(event) => setMode(event.target.value as Mode)}>
            <option value="radiation">Independent lineages</option>
            <option value="lineage">One lineage over time</option>
            <option value="locus">One gene swept</option>
          </select>
        </label>

        {mode === "locus" ? (
          <label>
            Gene
            <select
              value={gene}
              onChange={(event) => setGene(Number(event.target.value) as MorphGene)}
            >
              {locusOptions().map((option) => (
                <option key={option.gene} value={option.gene}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <label>
              Seed
              <input
                type="number"
                value={seed}
                onChange={(event) => setSeed(Number(event.target.value) | 0)}
              />
            </label>
            <label>
              Generations
              <input
                type="number"
                min={1}
                max={20000}
                value={generations}
                onChange={(event) =>
                  setGenerations(Math.max(1, Math.min(20000, Number(event.target.value) | 0)))
                }
              />
            </label>
          </>
        )}
      </div>

      <div ref={hostRef} className="dev-view__canvas" />

      <ol className="dev-view__legend">
        {bodies.map((body, index) => (
          <li key={`${body.label}-${index}`}>{body.label}</li>
        ))}
      </ol>
    </div>
  );
}
