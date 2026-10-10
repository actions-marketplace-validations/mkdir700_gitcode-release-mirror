// Passed to the child processes under test with --import. It changes where a
// TCP connection to port 443 goes (the mock server on loopback) and nothing
// else: names, certificates and every check of the code under test stay real.
import tls from 'node:tls';

const mockPort = Number(process.env.MOCK_PORT);
const original = tls.connect;
tls.connect = function (...args) {
  const options = typeof args[0] === 'object' && args[0] !== null ? args[0] : null;
  if (options && Number(options.port) === 443 && mockPort) {
    args[0] = { ...options, servername: options.servername || options.host, host: '127.0.0.1', port: mockPort };
  }
  return original.apply(this, args);
};
