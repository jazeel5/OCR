const { updateRepository } = require('../scripts/release-config.cjs');

module.exports = {
  ...require('./package.json').build,
  // GitHub Actions supplies the real repository automatically. Local builds
  // can opt in with OCR_UPDATE_REPOSITORY=owner/repo; no token is embedded.
  publish: updateRepository(),
};
