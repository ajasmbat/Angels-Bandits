// L11 neon layer (ANGE-ND1JQR): the neon-noir accents over the warm, realistic
// Manhattan base — tube outlines on select towers' crowns and setbacks
// (roofs.ts LED), rooftop neon signs (roof-details.ts), and neon window
// signs in shop and bar glass (buildings-material.ts, shader). The S2
// marquees, billboards and storefront strips (signage.ts) and the S1
// jumbotrons stay as they were and keep their own density gradient.
//
// ONE knob, NEON_DENSITY, scales all three, so the L9 reference-match gate
// can balance the neon against the references in one place. Colours are
// pink, cyan, violet and red over the amber window base; every neon element
// sits at or under the SIGN rung (EMISSIVE_SIGN), below the tracers.

import { EMISSIVE_SIGN } from "@angels-bandits/common/constants";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";

/**
 * The neon layer's density: the shipped value is the tuned look, 0 leaves
 * only S2's signs and the pre-L11 tower outlines. Scales
 * the tower outline chance (never below its pre-L11 share, so the VO3 crown
 * contract holds), the rooftop sign chance and the share of shop and bar
 * windows with a neon sign. The L9 gate's tuning knob.
 */
export const NEON_DENSITY = 1.25;

/** The neon palette, linear, before its rung boost: pink, cyan, violet and
 * red (the accents the references show) plus a warm amber tube. */
export const NEON_PALETTE = {
  pink: new THREE.Color(1.0, 0.12, 0.62),
  cyan: new THREE.Color(0.1, 0.82, 1.0),
  violet: new THREE.Color(0.55, 0.24, 1.0),
  red: new THREE.Color(1.0, 0.1, 0.12),
  amber: new THREE.Color(1.0, 0.5, 0.12),
} as const;

/** Neon window signs glow at the SIGN rung — a convex replacement of what
 * the shop glass emitted there, so a pixel is never sign + room. */
export const NEON_SIGN_RUNG = EMISSIVE_SIGN;

/** The palette in shader order, each lifted to exactly NEON_SIGN_RUNG. */
export const NEON_SIGN_COLORS: readonly THREE.Color[] = [
  NEON_PALETTE.pink,
  NEON_PALETTE.cyan,
  NEON_PALETTE.red,
  NEON_PALETTE.violet,
  NEON_PALETTE.amber,
].map((c) => c.clone().multiplyScalar(emissiveBoost(c, NEON_SIGN_RUNG)));

/** Share of storefronts with a neon sign in the window, and of the
 * second-floor windows over the shops with a bar or club sign. */
export const NEON_SHOP_SHARE = Math.min(0.6, 0.24 * NEON_DENSITY);
export const NEON_BAR_SHARE = Math.min(0.2, 0.05 * NEON_DENSITY);

/** A chance scaled by the density, clamped to [floor, 1]. */
export const neonChance = (base: number, floor = 0): number =>
  Math.min(1, Math.max(floor, base * NEON_DENSITY));
