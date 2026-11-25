'use strict';

const OVERLAY_WIDTH = 360;
const OVERLAY_HEIGHT = 440;
const EDGE_MARGIN = 24;
const FALLBACK_WORK_AREA = Object.freeze({ x: 0, y: 0, width: 1280, height: 800 });

const validPosition = value => Number.isSafeInteger(value);
const validDimension = value => Number.isSafeInteger(value) && value > 0;
const limit = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

function normalizeWorkArea(value) {
  if (!value || !validPosition(value.x) || !validPosition(value.y) ||
      !validDimension(value.width) || !validDimension(value.height)) return null;
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function fitInside(bounds, area) {
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    x: limit(bounds.x, area.x, area.x + area.width - width),
    y: limit(bounds.y, area.y, area.y + area.height - height),
    width,
    height
  };
}

/** Initial compact size. Saved dimensions are ignored; saved x/y are a pair. */
function createOverlayBounds(workArea, savedBounds = null) {
  const area = normalizeWorkArea(workArea) || FALLBACK_WORK_AREA;
  const savedPosition = savedBounds && validPosition(savedBounds.x) && validPosition(savedBounds.y);
  return fitInside({
    x: savedPosition ? savedBounds.x : area.x + area.width - OVERLAY_WIDTH - EDGE_MARGIN,
    y: savedPosition ? savedBounds.y : area.y + EDGE_MARGIN,
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT
  }, area);
}

function intersectionArea(bounds, area) {
  const width = Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x));
  const height = Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y));
  return width * height;
}

function centerDistance(bounds, area) {
  return Math.hypot(bounds.x + bounds.width / 2 - area.x - area.width / 2,
    bounds.y + bounds.height / 2 - area.y - area.height / 2);
}

/**
 * Keep an existing native window wholly on an available display. Prefer the
 * largest visible intersection, then the nearest center when a monitor vanished.
 * Caller orders its primary display first to resolve an exact tie consistently.
 */
function clampBoundsToDisplays(bounds, workAreas) {
  const areas = Array.isArray(workAreas) ? workAreas.map(normalizeWorkArea).filter(Boolean) : [];
  if (!areas.length) areas.push(FALLBACK_WORK_AREA);
  const first = areas[0];
  const width = validDimension(bounds?.width) ? limit(bounds.width, 280, 480) : OVERLAY_WIDTH;
  const height = validDimension(bounds?.height) ? limit(bounds.height, 280, 640) : OVERLAY_HEIGHT;
  const validSavedPosition = validPosition(bounds?.x) && validPosition(bounds?.y);
  const candidate = {
    x: validSavedPosition ? bounds.x : first.x + first.width - width - EDGE_MARGIN,
    y: validSavedPosition ? bounds.y : first.y + EDGE_MARGIN,
    width,
    height
  };
  let chosen = first;
  let largestIntersection = -1;
  let nearestDistance = Infinity;
  for (const area of areas) {
    const intersection = intersectionArea(candidate, area);
    const distance = centerDistance(candidate, area);
    if (intersection > largestIntersection || (intersection === largestIntersection && distance < nearestDistance)) {
      chosen = area;
      largestIntersection = intersection;
      nearestDistance = distance;
    }
  }
  return fitInside(candidate, chosen);
}

module.exports = { createOverlayBounds, clampBoundsToDisplays };
