// Jest's node environment doesn't carry over Node's built-in fetch (a lazy
// global); the API uses it for OIDC and REST connectors, so hand it over.
const jestConfig = require.resolve('jest-config', { paths: [require.resolve('jest-cli', { paths: [require.resolve('jest')] })] });
const { TestEnvironment } = require(require.resolve('jest-environment-node', { paths: [jestConfig] }));

class NodeWithFetch extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    for (const name of ['fetch', 'Request', 'Response', 'Headers', 'FormData']) {
      if (typeof this.global[name] === 'undefined') this.global[name] = globalThis[name];
    }
  }
}
module.exports = NodeWithFetch;
