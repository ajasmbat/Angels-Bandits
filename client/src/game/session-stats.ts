// S7 session stats — the pure seam behind the end-of-life card (same idiom
// as callouts.ts: no DOM). Everything counted is what the SERVER said about
// the local pilot: a hit is a `damage` with us as shooter, a kill a `death`
// credited to us, a medal an `award` naming us, the streak the one our
// score row carries. Only shots fired are counted locally — every one of
// them goes up the wire as a `fire`.

import type { MedalKind } from "@angels-bandits/common/medals";

/** What the kill-cam card shows for the life that just ended. */
export interface LifeCard {
  kills: number;
  shots: number;
  hits: number;
  /** Whole percent of shots that landed, or null when nothing was fired. */
  accuracy: number | null;
  /** The best streak this session (the server's count). */
  bestStreak: number;
  /** Medals earned this life, in award order (repeats kept: two DOUBLE
   * KILLs in one life are two medals). */
  medals: MedalKind[];
}

export class SessionStats {
  private shots = 0;
  private hits = 0;
  private kills = 0;
  private medals: MedalKind[] = [];
  private best = 0;
  /** The card of the life that just ended, while its kill-cam is up. */
  private shown: LifeCard | null = null;

  fired(): void {
    this.shots++;
  }

  hit(): void {
    this.hits++;
  }

  /** A credited kill of ours; while a card is up it is posthumous and
   * belongs to the life that just ended. */
  kill(): void {
    if (this.shown) this.shown.kills++;
    else this.kills++;
  }

  /** Medals from an award naming us — same posthumous rule as kill(). */
  award(medals: readonly MedalKind[]): void {
    if (this.shown) this.shown.medals.push(...medals);
    else this.medals.push(...medals);
  }

  /** Our score row's streak (server-owned). */
  streak(n: number): void {
    this.best = Math.max(this.best, n);
    if (this.shown) this.shown.bestStreak = this.best;
  }

  /**
   * The life ended: its card, built once. A second call for the same death
   * (a local crash, then the server's death message) returns the same card.
   */
  endLife(): LifeCard {
    if (this.shown) return this.shown;
    this.shown = {
      kills: this.kills,
      shots: this.shots,
      hits: this.hits,
      accuracy:
        this.shots > 0 ? Math.round((100 * this.hits) / this.shots) : null,
      bestStreak: this.best,
      medals: this.medals,
    };
    this.shots = 0;
    this.hits = 0;
    this.kills = 0;
    this.medals = [];
    return this.shown;
  }

  /** The card currently up (null while flying). */
  get card(): LifeCard | null {
    return this.shown;
  }

  /** Respawned: the card comes down, a fresh life counts from zero. */
  respawned(): void {
    this.shown = null;
  }
}
