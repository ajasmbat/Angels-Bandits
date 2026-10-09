// Billboarded name tags above remote planes. A THREE.Sprite always faces the
// camera, so billboarding is free; placement is torus-aware because the
// remote-plane manager positions tags via the same nearestImage placement as
// everything else rendered.

import * as THREE from "three";

/** Meters above a plane's position its tag floats. */
export const TAG_ALTITUDE = 6;

/** Human tag tint (matches the HUD's cool cyan). */
const HUMAN_COLOR = "#9fd8e8";
/** Bot (BANDIT) tag tint — hostile amber, obviously non-human. */
const BOT_COLOR = "#ffa26b";

export function createNameTag(name: string, isBot = false): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.font = "bold 30px ui-monospace, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 6;
    ctx.fillStyle = isBot ? BOT_COLOR : HUMAN_COLOR;
    ctx.fillText(name, canvas.width / 2, canvas.height / 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(20, 5, 1); // meters — readable at combat range, fog fades it
  return sprite;
}

export function disposeNameTag(sprite: THREE.Sprite): void {
  sprite.material.map?.dispose();
  sprite.material.dispose();
}

// --- P4: every tag in one draw ------------------------------------------------

/** Atlas cells: 4 × 4 tags of the sprite's own 256 × 64 canvas. */
const ATLAS_COLS = 4;
const ATLAS_ROWS = 4;
const CELL_W = 256;
const CELL_H = 64;
/** The sprite's size, m (createNameTag: scale 20 × 5). */
const TAG_W = 20;
const TAG_H = 5;

/**
 * P4: every remote's name tag as one instanced billboard over a canvas
 * atlas (a THREE.Sprite per tag was a draw each). Same look as the sprite:
 * the same canvas text per cell, a fixed 20 × 5 m quad facing the camera,
 * fogged, transparent, no depth write. A cell is allocated when a remote
 * appears, redrawn when its name arrives late, and freed when it leaves.
 */
export class NameTagBatch {
  readonly mesh: THREE.InstancedMesh;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly texture: THREE.CanvasTexture;
  private readonly uvRect: THREE.InstancedBufferAttribute;
  private readonly used: boolean[] = [];
  private n = 0;
  private warming = false;
  private readonly matrix = new THREE.Matrix4();

  constructor() {
    const canvas = document.createElement("canvas");
    canvas.width = CELL_W * ATLAS_COLS;
    canvas.height = CELL_H * ATLAS_ROWS;
    this.ctx = canvas.getContext("2d");
    this.texture = new THREE.CanvasTexture(canvas);
    const cells = ATLAS_COLS * ATLAS_ROWS;
    for (let i = 0; i < cells; i++) this.used.push(false);
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.uvRect = new THREE.InstancedBufferAttribute(
      new Float32Array(cells * 4),
      4,
    );
    this.uvRect.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aUvRect", this.uvRect);
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
    });
    material.customProgramCacheKey = () => "ab-tag-batch";
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nattribute vec4 aUvRect;",
        )
        .replace(
          "#include <uv_vertex>",
          "#include <uv_vertex>\nvMapUv = aUvRect.xy + uv * aUvRect.zw;",
        )
        .replace(
          "#include <project_vertex>",
          `vec4 mvPosition = modelViewMatrix * vec4(instanceMatrix[3].xyz, 1.0);
mvPosition.xy += position.xy * vec2(${TAG_W.toFixed(1)}, ${TAG_H.toFixed(1)});
gl_Position = projectionMatrix * mvPosition;`,
        );
    };
    this.mesh = new THREE.InstancedMesh(geometry, material, cells);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    // Billboards placed round the city every frame: no cached bound.
    this.mesh.frustumCulled = false;
  }

  /** A cell for `name` (-1 when the atlas is full: that tag is not drawn). */
  alloc(name: string, isBot: boolean): number {
    const cell = this.used.indexOf(false);
    if (cell < 0) return -1;
    this.used[cell] = true;
    this.paint(cell, name, isBot);
    return cell;
  }

  /** The name for `cell` arrived (or changed): redraw it. */
  rename(cell: number, name: string, isBot: boolean): void {
    if (cell >= 0 && this.used[cell]) this.paint(cell, name, isBot);
  }

  free(cell: number): void {
    if (cell >= 0) this.used[cell] = false;
  }

  begin(): void {
    this.n = 0;
  }

  /** Draw `cell`'s tag this frame TAG_ALTITUDE over `at` (a plane's
   * placed position — an object: doubles handed to a call are boxed). */
  place(cell: number, at: { x: number; y: number; z: number }): void {
    if (cell < 0 || this.warming) return;
    const k = this.n++;
    this.matrix.makeTranslation(at.x, at.y + TAG_ALTITUDE, at.z);
    this.mesh.setMatrixAt(k, this.matrix);
    const col = cell % ATLAS_COLS;
    const row = Math.floor(cell / ATLAS_COLS);
    // flipY: v runs bottom-up, the canvas rows top-down.
    this.uvRect.setXYZW(
      k,
      col / ATLAS_COLS,
      1 - (row + 1) / ATLAS_ROWS,
      1 / ATLAS_COLS,
      1 / ATLAS_ROWS,
    );
  }

  commit(): void {
    if (this.warming) return;
    this.mesh.count = this.n;
    if (this.n === 0) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.uvRect.needsUpdate = true;
  }

  /** Pre-warm: one parked tag drawn (see PlaneFleet.warm). */
  warm(on: boolean): void {
    this.warming = on;
    this.mesh.count = on ? 1 : 0;
    if (on) {
      this.mesh.setMatrixAt(0, this.matrix.makeTranslation(0, -9999, 0));
      this.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private paint(cell: number, name: string, isBot: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const x = (cell % ATLAS_COLS) * CELL_W;
    const y = Math.floor(cell / ATLAS_COLS) * CELL_H;
    ctx.save();
    ctx.clearRect(x, y, CELL_W, CELL_H);
    ctx.beginPath();
    ctx.rect(x, y, CELL_W, CELL_H);
    ctx.clip();
    ctx.font = "bold 30px ui-monospace, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 6;
    ctx.fillStyle = isBot ? BOT_COLOR : HUMAN_COLOR;
    ctx.fillText(name, x + CELL_W / 2, y + CELL_H / 2);
    ctx.restore();
    this.texture.needsUpdate = true;
  }
}
