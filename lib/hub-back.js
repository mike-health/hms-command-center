'use strict';

const HUB_URL = 'https://hms-partner-news.netlify.app';

function arrivedFromThisSite(referrer, origin) {
  if (!referrer || !origin) return false;
  try {
    return new URL(referrer).origin === origin;
  } catch {
    return false;
  }
}

function resolveHubBackTarget(referrer, origin) {
  if (arrivedFromThisSite(referrer, origin)) return { type: 'history' };
  return { type: 'redirect', url: HUB_URL };
}

module.exports = { HUB_URL, arrivedFromThisSite, resolveHubBackTarget };
