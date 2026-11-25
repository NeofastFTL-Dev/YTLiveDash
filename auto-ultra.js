/**
 * The rule behind the one-tap auto-fix: after every stream start the timer
 * reads the broadcast's latency class anyway, so when that class is not
 * ULTRA_LOW it can redo the switch by itself.
 *
 * Kept pure and separate from the server so the loop can be reasoned about (and
 * tested) without OBS, YouTube or a live broadcast.
 *
 * Attempts are counted across the *chain* of automatic switches, not per
 * broadcast: each switch ends the broadcast it was judging, so without a cap
 * two wrong answers would restart the stream forever. Two tries, then stop and
 * say so — a channel that lands on Normal twice has the wrong Stream latency
 * setting in Studio, and nothing on this side can change that.
 */
const MAX_ATTEMPTS = 2;

/**
 * @param {object} input
 * @param {boolean} input.enabled    auto-fix switched on by the operator
 * @param {string|null} input.cls    ULTRA_LOW | LOW | NORMAL | null (not read yet)
 * @param {number} input.attempts    automatic switches already made in this chain
 * @param {boolean} input.gaveUp     the cap was reached; stay put until reset
 * @param {boolean} input.switching  a switch is already running right now
 * @returns {{action: "idle"|"ok"|"reset"|"switch"|"giveup"|"gaveup-stop", attempts?: number, reason?: string}}
 */
function decide({ enabled, cls, attempts = 0, gaveUp = false, switching = false }) {
  if (!enabled) return { action: "idle", reason: "auto-fix is off" };
  if (!cls) return { action: "idle", reason: "no class read yet" };
  if (switching) return { action: "idle", reason: "a switch is already running" };
  if (cls === "ULTRA_LOW") {
    // Clear the chain: the broadcast is right, so the next one starts fresh.
    return attempts || gaveUp ? { action: "reset" } : { action: "ok" };
  }
  if (gaveUp) return { action: "gaveup-stop" };
  if (attempts >= MAX_ATTEMPTS) return { action: "giveup", attempts };
  return { action: "switch", attempts: attempts + 1 };
}

module.exports = { decide, MAX_ATTEMPTS };
