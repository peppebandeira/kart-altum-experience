/* ================================================================
   MOTOR DE PONTUAÇÃO — "ALTUM GP"
   Kart Altum Experience. Puro, sem estado, re-derivável do banco.
   Regras (config no db.json):
   - Posição (top 10): 25-18-15-12-10-8-6-4-2-1
   - Presença: +2 a todo piloto que largou (inclui DNF)
   - Volta mais rápida da corrida: +1 (menor best_lap_ms da etapa)
   - Pole: +2 (result.grid_pole === true)
   - Descarte: best (total_rounds - discard_worst) de N corridas
   ================================================================ */

const KartGP = (function () {

  function msToTime(ms) {
    if (ms == null) return "—";
    const totalSec = ms / 1000;
    const m = Math.floor(totalSec / 60);
    const s = (totalSec - m * 60).toFixed(3).padStart(6, "0");
    return (m > 0 ? m + ":" : "0:") + s;
  }

  // Id do piloto que fez a volta mais rápida da corrida (menor best_lap_ms).
  function fastestLapPilot(db, raceId) {
    const rows = db.results.filter(r => r.race_id === raceId && r.best_lap_ms != null);
    if (!rows.length) return null;
    return rows.reduce((a, b) => (b.best_lap_ms < a.best_lap_ms ? b : a)).pilot_id;
  }

  // Pontos de UM resultado numa corrida, detalhado.
  function pointsForResult(db, result) {
    const cfg = db.config;
    const table = cfg.points_by_position;
    const flPilot = fastestLapPilot(db, result.race_id);

    const position = (result.finish_pos && result.finish_pos >= 1 && result.finish_pos <= table.length)
      ? table[result.finish_pos - 1] : 0;
    const presence = cfg.presence_points;           // largou => sempre soma
    const fastest = (result.pilot_id === flPilot) ? cfg.fastest_lap_points : 0;
    const pole = result.grid_pole ? cfg.pole_points : 0;

    return {
      position, presence, fastest, pole,
      total: position + presence + fastest + pole,
      is_fastest: fastest > 0,
      is_pole: pole > 0
    };
  }

  // Tabela de uma corrida, ordenada por posição de chegada (DNF ao fim).
  function raceTable(db, raceId) {
    const rows = db.results.filter(r => r.race_id === raceId).map(r => {
      const pilot = db.pilots.find(p => p.pilot_id === r.pilot_id) || { name: r.pilot_id };
      return { ...r, pilot, points: pointsForResult(db, r) };
    });
    rows.sort((a, b) => {
      if (a.finish_pos == null && b.finish_pos == null) return 0;
      if (a.finish_pos == null) return 1;
      if (b.finish_pos == null) return -1;
      return a.finish_pos - b.finish_pos;
    });
    return rows;
  }

  // Classificação do campeonato com descarte best (total_rounds - discard_worst).
  function championship(db) {
    const cfg = db.config;
    const keep = Math.max(1, cfg.total_rounds - cfg.discard_worst); // N que conta (=4)

    const byPilot = {};
    db.results.forEach(r => {
      const pts = pointsForResult(db, r).total;
      if (!byPilot[r.pilot_id]) byPilot[r.pilot_id] = [];
      byPilot[r.pilot_id].push({ race_id: r.race_id, points: pts, finish_pos: r.finish_pos });
    });

    const standings = Object.keys(byPilot).map(pid => {
      const races = byPilot[pid];
      const played = races.length;
      const sorted = [...races].sort((a, b) => b.points - a.points);
      const kept = sorted.slice(0, Math.min(played, keep));
      const dropped = sorted.slice(Math.min(played, keep));
      const total = kept.reduce((s, x) => s + x.points, 0);
      const grossTotal = races.reduce((s, x) => s + x.points, 0);

      const pilot = db.pilots.find(p => p.pilot_id === pid) || { name: pid };
      const wins = races.filter(x => x.finish_pos === 1).length;
      const poles = db.results.filter(r => r.pilot_id === pid && r.grid_pole).length;
      const fastest = db.races.filter(rc => fastestLapPilot(db, rc.race_id) === pid).length;

      return {
        pilot_id: pid, pilot, played, total, grossTotal,
        dropped_points: grossTotal - total,
        wins, poles, fastest_laps: fastest
      };
    });

    standings.sort((a, b) =>
      b.total - a.total || b.wins - a.wins || b.poles - a.poles || b.fastest_laps - a.fastest_laps
    );
    standings.forEach((s, i) => s.rank = i + 1);
    return standings;
  }

  // Retrato de um piloto: temporada + cada corrida.
  function pilotPortrait(db, pilotId) {
    const pilot = db.pilots.find(p => p.pilot_id === pilotId);
    const rows = db.results.filter(r => r.pilot_id === pilotId).map(r => {
      const race = db.races.find(rc => rc.race_id === r.race_id);
      return { ...r, race, points: pointsForResult(db, r) };
    });
    rows.sort((a, b) => (a.race?.round || 0) - (b.race?.round || 0));

    const standings = championship(db);
    const me = standings.find(s => s.pilot_id === pilotId);
    const bestLap = rows.reduce((best, r) =>
      (r.best_lap_ms != null && (best == null || r.best_lap_ms < best)) ? r.best_lap_ms : best, null);

    return { pilot, rows, season: me, best_lap_ms: bestLap };
  }

  /* ---- SEMÁFORO (verde/amarelo/vermelho, sempre relativo ao contexto) ---- */

  // Corrida: cor pela posição dentro do grid daquele dia.
  function semaphoreRacePosition(finishPos, fieldSize) {
    if (finishPos == null) return "sem-bad";
    const t = fieldSize / 3;
    if (finishPos <= t) return "sem-good";
    if (finishPos <= 2 * t) return "sem-mid";
    return "sem-bad";
  }

  // Piloto: cor comparando uma corrida à média de posição do próprio piloto.
  function semaphoreVsSelf(finishPos, avgPos) {
    if (finishPos == null || avgPos == null) return "sem-bad";
    if (finishPos <= avgPos - 1) return "sem-good";
    if (finishPos >= avgPos + 1) return "sem-bad";
    return "sem-mid";
  }

  // Campeonato: cor pelo terço do ranking.
  function semaphoreRank(rank, total) {
    const t = total / 3;
    if (rank <= t) return "sem-good";
    if (rank <= 2 * t) return "sem-mid";
    return "sem-bad";
  }

  return {
    msToTime, fastestLapPilot, pointsForResult, raceTable,
    championship, pilotPortrait,
    semaphoreRacePosition, semaphoreVsSelf, semaphoreRank
  };
})();

if (typeof module !== "undefined") module.exports = KartGP;
