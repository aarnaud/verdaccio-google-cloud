import debugCore from 'debug';

const debug = debugCore('verdaccio:plugin:google-cloud:config');

// `sensitive` keeps the resolved value out of the debug output (DEBUG=verdaccio:plugin* is a
// common troubleshooting switch and its output ends up in shared logs)
export default (configValue: any, sensitive = false): string => {
  const envValue = process.env[configValue];
  if (envValue) {
    debug('resolved %o from env var → %o', configValue, sensitive ? '[redacted]' : envValue);
    return envValue;
  }
  debug('using literal value for %o', sensitive ? '[redacted]' : configValue);
  return configValue;
};
