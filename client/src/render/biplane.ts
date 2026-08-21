// Procedural vintage aerobatic biplane (Stearman-style) built entirely from
// Three.js geometry — no external assets, per the project constraint that
// everything ships bundled. Reference: red fuselage/wings, maroon cowl ring,
// checkered rudder, N-struts with crossed flying wires, open cockpit,
// radial engine, spatted gear.
//
// Axes: +Z = nose, +Y = up. Model is ~9 units wingspan (≈ meters).

import * as THREE from "three";

const RED = 0xc8102e;
const MAROON = 0x77111f;
const CREAM = 0xf2ead8;
const SILVER = 0xd6d8da;
const DARK = 0x1d1d20;
const TIRE = 0x141414;

function mats() {
  return {
    red: new THREE.MeshStandardMaterial({
      color: RED,
      roughness: 0.32,
      metalness: 0.12,
    }),
    maroon: new THREE.MeshStandardMaterial({
      color: MAROON,
      roughness: 0.35,
      metalness: 0.2,
    }),
    cream: new THREE.MeshStandardMaterial({
      color: CREAM,
      roughness: 0.5,
      metalness: 0.05,
    }),
    chrome: new THREE.MeshStandardMaterial({
      color: 0xe8eaec,
      roughness: 0.12,
      metalness: 1.0,
    }),
    silver: new THREE.MeshStandardMaterial({
      color: SILVER,
      roughness: 0.4,
      metalness: 0.7,
    }),
    dark: new THREE.MeshStandardMaterial({
      color: DARK,
      roughness: 0.6,
      metalness: 0.4,
    }),
    tire: new THREE.MeshStandardMaterial({
      color: TIRE,
      roughness: 0.95,
      metalness: 0.0,
    }),
    leather: new THREE.MeshStandardMaterial({
      color: 0x4a3220,
      roughness: 0.9,
      metalness: 0.0,
    }),
    glass: new THREE.MeshStandardMaterial({
      color: 0xbfd9e8,
      roughness: 0.05,
      metalness: 0.1,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
    }),
    wire: new THREE.MeshStandardMaterial({
      color: 0xb9bbbd,
      roughness: 0.35,
      metalness: 0.9,
    }),
  };
}

function checkerTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  if (!g) return new THREE.Texture(); // 2d canvas is universal; typing only
  const n = 6;
  const s = c.width / n;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      g.fillStyle = (i + j) % 2 ? "#111111" : "#f5f2ea";
      g.fillRect(i * s, j * s, s, s);
    }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// Rounded-end wing planform in the XY plane, extruded to thickness.
function wingGeometry(
  span: number,
  chord: number,
  thickness: number,
): THREE.BufferGeometry {
  const hs = span / 2;
  const hc = chord / 2;
  const r = hc;
  const sh = new THREE.Shape();
  sh.moveTo(-hs + r, -hc);
  sh.lineTo(hs - r, -hc);
  sh.quadraticCurveTo(hs + hc * 0.35, 0, hs - r, hc);
  sh.lineTo(-hs + r, hc);
  sh.quadraticCurveTo(-hs - hc * 0.35, 0, -hs + r, -hc);
  const geo = new THREE.ExtrudeGeometry(sh, {
    depth: thickness * 0.5,
    bevelEnabled: true,
    bevelThickness: thickness * 0.25,
    bevelSize: thickness * 0.35,
    bevelSegments: 3,
    curveSegments: 24,
  });
  geo.rotateX(Math.PI / 2); // extrusion axis -> Y (thickness), chord -> Z
  geo.center();
  return geo;
}

function strut(
  a: THREE.Vector3,
  b: THREE.Vector3,
  radius: number,
  material: THREE.Material,
  streamline = true,
): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const geo = new THREE.CylinderGeometry(radius, radius, len, 10);
  const m = new THREE.Mesh(geo, material);
  if (streamline) m.scale.x = 0.55; // airfoil-ish cross-section
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}

export function createBiplane(): THREE.Group {
  const M = mats();
  const g = new THREE.Group();

  // ---------- fuselage (lathe of a side profile, squashed slightly oval)
  const profile: THREE.Vector2[] = [
    new THREE.Vector2(0.34, 3.26), // open cowl mouth — engine visible inside
    new THREE.Vector2(0.5, 3.22),
    new THREE.Vector2(0.62, 2.75),
    new THREE.Vector2(0.63, 2.1),
    new THREE.Vector2(0.58, 1.1),
    new THREE.Vector2(0.52, 0.0),
    new THREE.Vector2(0.4, -1.5),
    new THREE.Vector2(0.24, -2.6),
    new THREE.Vector2(0.1, -3.25),
    new THREE.Vector2(0.001, -3.3),
  ];
  const fus = new THREE.Mesh(new THREE.LatheGeometry(profile, 28), M.red);
  fus.geometry.rotateX(Math.PI / 2); // lathe axis -> Z
  fus.scale.x = 0.88;
  g.add(fus);

  // cream cheat-line stripe along each flank
  for (const sx of [1, -1]) {
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(0.02, 0.09, 5.6),
      M.cream,
    );
    stripe.position.set(sx * 0.51, 0.13, -0.35);
    stripe.rotation.y = sx * -0.035;
    g.add(stripe);
  }

  // ---------- cowl ring + radial engine + prop
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.4, 0.085, 14, 36),
    M.maroon,
  );
  ring.scale.z = 1.6;
  ring.position.z = 3.24;
  g.add(ring);
  const firewall = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.5, 0.06, 24),
    M.dark,
  );
  firewall.rotation.x = Math.PI / 2;
  firewall.position.z = 2.95;
  g.add(firewall);
  const crank = new THREE.Mesh(
    new THREE.CylinderGeometry(0.17, 0.2, 0.3, 20),
    M.dark,
  );
  crank.rotation.x = Math.PI / 2;
  crank.position.z = 3.28;
  g.add(crank);
  for (let i = 0; i < 7; i++) {
    // 7-cylinder radial peeking through the cowl
    const a = (i / 7) * Math.PI * 2;
    const cyl = new THREE.Mesh(
      new THREE.CylinderGeometry(0.075, 0.075, 0.26, 10),
      M.dark,
    );
    cyl.position.set(Math.cos(a) * 0.28, Math.sin(a) * 0.28, 3.18);
    cyl.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(Math.cos(a), Math.sin(a), 0),
    );
    g.add(cyl);
  }
  const spinner = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 20, 14),
    M.chrome,
  );
  spinner.scale.z = 1.7;
  spinner.position.z = 3.52;
  g.add(spinner);
  const prop = new THREE.Group();
  prop.name = "propeller"; // spin this at runtime
  for (const rot of [0, Math.PI]) {
    const blade = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.1, 1.55, 10),
      M.silver,
    );
    blade.scale.z = 0.28;
    blade.position.y = 0.82;
    const holder = new THREE.Group();
    holder.add(blade);
    blade.rotation.y = 0.42; // blade pitch
    holder.rotation.z = rot;
    prop.add(holder);
  }
  prop.position.z = 3.5;
  g.add(prop);

  // ---------- wings (upper larger + forward, lower staggered back)
  const upper = new THREE.Mesh(wingGeometry(9.0, 1.5, 0.15), M.red);
  upper.position.set(0, 1.38, 0.62);
  g.add(upper);
  const lower = new THREE.Mesh(wingGeometry(7.3, 1.35, 0.14), M.red);
  lower.position.set(0, -0.32, 0.18);
  g.add(lower);
  // aileron hinge lines (subtle darker strips, outer trailing edges)
  for (const [wing, span, y, z, chord] of [
    [upper, 9.0, 1.38, 0.62, 1.5],
    [lower, 7.3, -0.32, 0.18, 1.35],
  ] as const) {
    void wing;
    for (const sx of [1, -1]) {
      const hinge = new THREE.Mesh(
        new THREE.BoxGeometry(span * 0.32, 0.02, 0.03),
        M.maroon,
      );
      hinge.position.set(sx * span * 0.31, y + 0.055, z - chord * 0.31);
      g.add(hinge);
    }
  }

  // ---------- cabane + interplane struts
  const cab: [THREE.Vector3, THREE.Vector3][] = [
    [new THREE.Vector3(0.3, 0.52, 1.05), new THREE.Vector3(0.55, 1.3, 0.95)],
    [new THREE.Vector3(0.3, 0.5, 0.15), new THREE.Vector3(0.55, 1.3, 0.3)],
  ];
  for (const sx of [1, -1])
    for (const [a, b] of cab)
      g.add(
        strut(
          new THREE.Vector3(a.x * sx, a.y, a.z),
          new THREE.Vector3(b.x * sx, b.y, b.z),
          0.035,
          M.cream,
        ),
      );
  for (const sx of [1, -1]) {
    const xo = 3.05;
    const lowF = new THREE.Vector3(xo * sx, -0.25, 0.55);
    const lowR = new THREE.Vector3(xo * sx, -0.25, -0.25);
    const upF = new THREE.Vector3(xo * sx, 1.32, 1.0);
    const upR = new THREE.Vector3(xo * sx, 1.32, 0.25);
    g.add(strut(lowF, upF, 0.04, M.cream));
    g.add(strut(lowR, upR, 0.04, M.cream));
    g.add(strut(lowR, upF, 0.028, M.cream)); // N diagonal
    // crossed flying wires, front and rear bays
    const rootLowF = new THREE.Vector3(0.62 * sx, -0.28, 0.55);
    const rootLowR = new THREE.Vector3(0.62 * sx, -0.28, -0.2);
    const rootUpF = new THREE.Vector3(0.6 * sx, 1.3, 1.0);
    const rootUpR = new THREE.Vector3(0.6 * sx, 1.3, 0.3);
    g.add(strut(rootLowF, upF, 0.011, M.wire, false));
    g.add(strut(rootLowR, upR, 0.011, M.wire, false));
    g.add(strut(rootUpF, lowF, 0.011, M.wire, false));
    g.add(strut(rootUpR, lowR, 0.011, M.wire, false));
  }

  // ---------- cockpit (open, leather coaming) + windshield + headrest fairing
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(0.3, 0.055, 12, 26),
    M.leather,
  );
  rim.rotation.x = Math.PI / 2;
  rim.scale.set(1, 1.35, 1);
  rim.position.set(0, 0.44, -0.75);
  g.add(rim);
  const pit = new THREE.Mesh(
    new THREE.CylinderGeometry(0.29, 0.24, 0.3, 20),
    M.dark,
  );
  pit.scale.z = 1.35;
  pit.position.set(0, 0.3, -0.75);
  g.add(pit);
  const shield = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.3), M.glass);
  shield.position.set(0, 0.62, -0.28);
  shield.rotation.x = -0.5;
  g.add(shield);
  const fair = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 12), M.red);
  fair.scale.set(0.8, 1.0, 3.2);
  fair.position.set(0, 0.42, -1.72);
  g.add(fair);

  // ---------- tail: fin (red), rudder (checkered), stabilizer + wires
  const finShape = new THREE.Shape();
  finShape.moveTo(-0.0, 0);
  finShape.lineTo(0.75, 0);
  finShape.quadraticCurveTo(0.85, 0.55, 0.45, 0.95);
  finShape.quadraticCurveTo(0.2, 1.05, 0.0, 0.9);
  finShape.lineTo(0, 0);
  const fin = new THREE.Mesh(
    new THREE.ExtrudeGeometry(finShape, {
      depth: 0.045,
      bevelEnabled: false,
      curveSegments: 16,
    }),
    M.red,
  );
  fin.rotation.y = -Math.PI / 2; // shape x -> +Z(forward), lies on center plane
  fin.position.set(0.022, 0.25, -2.55 - 0.75); // shape x=0 at hinge z=-3.3
  g.add(fin);

  const rudShape = new THREE.Shape();
  rudShape.moveTo(0, -0.15);
  rudShape.lineTo(0, 0.95);
  rudShape.quadraticCurveTo(-0.55, 1.0, -0.62, 0.45);
  rudShape.quadraticCurveTo(-0.66, -0.05, -0.35, -0.22);
  rudShape.lineTo(0, -0.15);
  const checker = checkerTexture();
  const rudMat = new THREE.MeshStandardMaterial({
    map: checker,
    roughness: 0.5,
    metalness: 0.05,
  });
  const rudGeo = new THREE.ExtrudeGeometry(rudShape, {
    depth: 0.04,
    bevelEnabled: false,
    curveSegments: 16,
  });
  // planar UVs over the shape so the checker maps cleanly on both faces
  rudGeo.computeBoundingBox();
  const bb = rudGeo.boundingBox ?? new THREE.Box3();
  const uv = rudGeo.attributes.uv as THREE.BufferAttribute;
  const pos = rudGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(
      i,
      (pos.getX(i) - bb.min.x) / (bb.max.x - bb.min.x),
      (pos.getY(i) - bb.min.y) / (bb.max.y - bb.min.y),
    );
  }
  const rudder = new THREE.Mesh(rudGeo, rudMat);
  rudder.rotation.y = -Math.PI / 2;
  rudder.position.set(0.02, 0.25, -3.32);
  g.add(rudder);

  const stab = new THREE.Mesh(wingGeometry(3.3, 0.95, 0.08), M.red);
  stab.position.set(0, 0.16, -2.95);
  g.add(stab);
  for (const sx of [1, -1]) {
    // tail bracing wires
    g.add(
      strut(
        new THREE.Vector3(0, 1.05, -3.1),
        new THREE.Vector3(1.35 * sx, 0.18, -2.95),
        0.009,
        M.wire,
        false,
      ),
    );
    g.add(
      strut(
        new THREE.Vector3(0, -0.2, -3.05),
        new THREE.Vector3(1.35 * sx, 0.14, -2.95),
        0.009,
        M.wire,
        false,
      ),
    );
  }

  // ---------- landing gear: red streamlined legs, spreader, wheels, tailwheel
  for (const sx of [1, -1]) {
    const hub = new THREE.Vector3(0.98 * sx, -1.22, 0.85);
    g.add(strut(new THREE.Vector3(0.34 * sx, -0.42, 1.35), hub, 0.055, M.red));
    g.add(strut(new THREE.Vector3(0.36 * sx, -0.4, 0.45), hub, 0.055, M.red));
    g.add(
      strut(
        new THREE.Vector3(0.6 * sx, -0.3, 0.55),
        new THREE.Vector3(-0.98 * sx, -1.22, 0.85),
        0.012,
        M.wire,
        false,
      ),
    );
    const tire = new THREE.Mesh(
      new THREE.TorusGeometry(0.245, 0.115, 14, 26),
      M.tire,
    );
    tire.rotation.y = Math.PI / 2;
    tire.position.copy(hub);
    g.add(tire);
    for (const hx of [0.075, -0.075]) {
      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.17, 0.19, 0.15, 20),
        M.red,
      );
      cap.rotation.z = Math.PI / 2;
      cap.position.copy(hub).add(new THREE.Vector3(hx * sx, 0, 0));
      g.add(cap);
    }
  }
  const spreader = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 1.96, 10),
    M.red,
  );
  spreader.rotation.z = Math.PI / 2;
  spreader.scale.z = 0.6;
  spreader.position.set(0, -1.22, 0.85);
  g.add(spreader);
  const tw = new THREE.Mesh(
    new THREE.TorusGeometry(0.08, 0.045, 10, 18),
    M.tire,
  );
  tw.rotation.y = Math.PI / 2;
  tw.position.set(0, -0.52, -3.0);
  g.add(tw);
  g.add(
    strut(
      new THREE.Vector3(0, -0.18, -2.85),
      new THREE.Vector3(0, -0.5, -3.0),
      0.035,
      M.silver,
    ),
  );

  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.receiveShadow = false;
    }
  });
  return g;
}
