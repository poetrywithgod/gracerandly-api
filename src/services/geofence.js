const { getDistance } = require("geolib");
const { supabase } = require("../config/supabase");

const RADIUS_M = Number(process.env.GEOFENCE_RADIUS_METERS || 150);
const DEVIATION_M = Number(process.env.ROUTE_DEVIATION_METERS || 400);
const DEVIATION_MIN = Number(process.env.ROUTE_DEVIATION_MINUTES || 3);
const STATIONARY_MIN = Number(process.env.STATIONARY_FLAG_MINUTES || 5);

/**
 * Checks whether a Runner's reported GPS location is within the geofence
 * radius of the pickup/dropoff point. This is the gate that must pass
 * before a status change to "picked up" or "delivered" is accepted.
 * (PRD §6.4 — "Pickup and delivery status changes are only accepted when
 * the Runner's GPS location is within a defined radius...")
 */
async function checkGeofence({ errandId, checkType, runnerLat, runnerLng, targetLat, targetLng }) {
  const distanceMeters = getDistance(
    { latitude: runnerLat, longitude: runnerLng },
    { latitude: targetLat, longitude: targetLng }
  );

  const passed = distanceMeters <= RADIUS_M;

  const { error } = await supabase.from("geofence_checks").insert({
    errand_id: errandId,
    check_type: checkType,
    runner_location: `POINT(${runnerLng} ${runnerLat})`,
    target_location: `POINT(${targetLng} ${targetLat})`,
    distance_meters: distanceMeters,
    radius_threshold_meters: RADIUS_M,
    passed,
  });

  if (error) throw error;

  return { passed, distanceMeters, radiusMeters: RADIUS_M };
}

/**
 * Flags a route deviation to the Admin operations dashboard.
 * Two-part threshold per the Decision Addendum, to avoid false positives
 * from ordinary traffic stops: >400m off-route for >3 continuous minutes,
 * OR stationary at an unexpected point for >5 minutes.
 */
async function flagRouteDeviation({ errandId, runnerId, deviationMeters, durationSeconds, reason }) {
  const isOffRoute = reason === "off_route" && deviationMeters >= DEVIATION_M && durationSeconds >= DEVIATION_MIN * 60;
  const isStationary = reason === "unexpected_stationary" && durationSeconds >= STATIONARY_MIN * 60;

  if (!isOffRoute && !isStationary) {
    return { flagged: false };
  }

  const { data, error } = await supabase
    .from("route_deviation_flags")
    .insert({
      errand_id: errandId,
      runner_id: runnerId,
      deviation_meters: deviationMeters,
      duration_seconds: durationSeconds,
      trigger_reason: reason,
    })
    .select()
    .single();

  if (error) throw error;

  // TODO: push to Admin ops dashboard via realtime channel once that's wired up
  return { flagged: true, incident: data };
}

module.exports = { checkGeofence, flagRouteDeviation, RADIUS_M, DEVIATION_M };
