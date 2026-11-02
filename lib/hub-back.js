'use strict';

const HUB_URL = 'https://hms-partner-news.netlify.app/';
const HUB_BAR_LABEL = '← Back to HMS hub';

function hubBarAttrs() {
  return {
    href: HUB_URL,
    className: 'hms-hub-return',
    text: HUB_BAR_LABEL
  };
}

module.exports = { HUB_URL, HUB_BAR_LABEL, hubBarAttrs };
