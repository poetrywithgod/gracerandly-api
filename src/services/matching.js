const { supabase } = require("../config/supabase");

const INITIAL_RADIUS = Number(process.env.INITIAL_MATCH_RADIUS_METERS || 4828); // 3 miles
const EXPANSION_FACTOR = Number(process.env.MATCH_RADIUS_EXPANSION_FACTOR || 1.6);
const MAX_ATTEMPTS = Number(process.env.MAX_MATCH_ATTEMPTS || 4); // 4828 -> ~7725 -> ~12360 -> ~19776m (~12.3mi cap)

function scoreCandidate({ distanceMeters, radiusMeters, avgRating }) {
  const proximityScore = 1 - Math.min(distanceMeters / radiusMeters, 1);
  const reliabilityScore = (avgRating ?? 4.0) / 5;
  return proximityScore * 0.6 + reliabilityScore * 0.4;
}

async function getAverageRatings(runnerIds) {
  if (runnerIds.length === 0) return {};
  const { data, error } = await supabase.from("ratings").select("ratee_id, stars").in("ratee_id", runnerIds);
  if (error) throw error;

  const sums = {};
  const counts = {};
  for (const row of data) {
    sums[row.ratee_id] = (sums[row.ratee_id] || 0) + row.stars;
    counts[row.ratee_id] = (counts[row.ratee_id] || 0) + 1;
  }
  const avgs = {};
  for (const id of runnerIds) {
    avgs[id] = counts[id] ? sums[id] / counts[id] : null;
  }
  return avgs;
}

async function matchErrand(errandId, { excludeRunnerIds = [] } = {}) {
  let radius = INITIAL_RADIUS;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { data: candidates, error } = await supabase.rpc("match_runners_for_errand", {
      p_errand_id: errandId,
      p_radius_m: Math.round(radius),
      p_exclude: excludeRunnerIds,
    });
    if (error) throw error;

    if (candidates && candidates.length > 0) {
      const runnerIds = candidates.map((c) => c.runner_id);
      const avgRatings = await getAverageRatings(runnerIds);

      const scored = candidates
        .map((c) => ({
          ...c,
          score: scoreCandidate({
            distanceMeters: c.distance_meters,
            radiusMeters: radius,
            avgRating: avgRatings[c.runner_id],
          }),
        }))
        .sort((a, b) => b.score - a.score);

      const best = scored[0];

      const { error: updateErr } = await supabase
        .from("errands")
        .update({
          status: "matched",
          offered_runner_id: best.runner_id,
          offered_at: new Date().toISOString(),
          match_radius_meters: Math.round(radius),
          matching_score: best.score,
        })
        .eq("id", errandId);

      if (updateErr) throw updateErr;

      await supabase.from("analytics_events").insert({
        event_name: "matched",
        errand_id: errandId,
        metadata: { runner_id: best.runner_id, attempt, radius_meters: Math.round(radius), score: best.score },
      });

      return { matched: true, runnerId: best.runner_id, radiusMeters: Math.round(radius), attempt, candidateCount: candidates.length };
    }

    radius *= EXPANSION_FACTOR;
  }

  await supabase.from("analytics_events").insert({
    event_name: "match_failed",
    errand_id: errandId,
    metadata: { attempts: MAX_ATTEMPTS, final_radius_meters: Math.round(radius) },
  });

  return { matched: false, radiusMeters: Math.round(radius), attempts: MAX_ATTEMPTS };
}

module.exports = { matchErrand, scoreCandidate };
