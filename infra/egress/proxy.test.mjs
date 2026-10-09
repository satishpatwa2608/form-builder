import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createProxy, neverReach, parseAllow, refusal } from './proxy.mjs';

describe('The list of allowed addresses', () => {
  it('reads host, host:port and host:port=private', () => {
    assert.deepEqual([...parseAllow('API.acme.com, erp.acme.com:8443 ,erp.internal:8080=private')], [
      ['api.acme.com:443', { private: false }],
      ['erp.acme.com:8443', { private: false }],
      ['erp.internal:8080', { private: true }],
    ]);
    assert.equal(parseAllow('').size, 0);
    assert.equal(parseAllow(undefined).size, 0);
  });
  it('refuses anything it does not understand, rather than guess', () => {
    for (const bad of ['*.acme.com', 'http://acme.com', 'acme.com:0', 'acme.com:99999', 'acme.com:443:1', 'acme com', 'acme.com/path', '-acme.com']) {
      assert.throws(() => parseAllow(bad), /is not host/, bad);
    }
  });
});

describe('Addresses that may not be connected to', () => {
  it('the machine itself and the metadata service: never, even for a private entry', () => {
    for (const ip of ['127.0.0.1', '127.8.8.8', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', '::ffff:127.0.0.1', '224.0.0.1']) {
      assert.notEqual(refusal(ip, true), '', ip);
    }
  });
  it('private ranges: only for an entry marked private', () => {
    for (const ip of ['10.1.2.3', '172.16.0.9', '172.31.255.255', '192.168.1.1', '100.64.0.1', 'fd00::1', '::ffff:10.0.0.1']) {
      assert.equal(refusal(ip, false), 'a private address', ip);
      assert.equal(refusal(ip, true), '', ip);
    }
  });
  it('the network it shares with the product can be put out of reach for good', () => {
    assert.equal(refusal('10.77.0.5', true), '');
    neverReach('10.77.0.0/16');
    assert.equal(refusal('10.77.0.5', true), 'an address that is never allowed');
    assert.equal(refusal('10.78.0.5', true), '');
    assert.throws(() => neverReach('not-a-network'), /is not a network/);
  });
  it('public addresses are fine', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:2800:220:1:248:1893:25c8:1946']) assert.equal(refusal(ip, false), '', ip);
    assert.equal(refusal('not-an-ip', true), 'not an address');
  });
});

describe('The proxy', () => {
  let target;
  let targetPort;
  let proxy;
  let proxyPort;
  const seen = [];
  const log = [];
  // Stand-ins for the internet: every name "resolves" to what this table says.
  const names = {};

  before(async () => {
    target = http.createServer((req, res) => {
      seen.push({ url: req.url, host: req.headers.host, proxyAuth: req.headers['proxy-authorization'] });
      res.writeHead(200, { 'content-type': 'text/plain' }).end(`hello from ${req.headers.host}`);
    });
    await new Promise((ok) => target.listen(0, '127.0.0.1', ok));
    targetPort = target.address().port;
    Object.assign(names, { 'erp.acme.test': ['10.9.9.9'], 'sneaky.acme.test': ['169.254.169.254'], 'inside.acme.test': ['10.0.0.5'] });
    const allow = parseAllow(`erp.acme.test:${targetPort}=private,sneaky.acme.test:${targetPort}=private,inside.acme.test:${targetPort},gone.acme.test:${targetPort}`);
    proxy = createProxy({
      allow,
      log: (e) => log.push(e),
      connectTimeoutMs: 1500,
      // The "private" system is really this machine's test server: say so only at the last moment, as a private link would.
      resolve: async (host) => {
        if (!names[host]) throw new Error('ENOTFOUND');
        return names[host];
      },
    });
    await new Promise((ok) => proxy.listen(0, '127.0.0.1', ok));
    proxyPort = proxy.address().port;
  });
  after(() => {
    target.close();
    proxy.close();
  });

  const viaProxy = (url, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: url, headers: { host: new URL(url).host, ...headers } }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });
  const connect = (hostPort) =>
    new Promise((resolve) => {
      const socket = net.connect(proxyPort, '127.0.0.1', () => socket.write(`CONNECT ${hostPort} HTTP/1.1\r\nhost: ${hostPort}\r\n\r\n`));
      let data = '';
      socket.on('data', (d) => {
        data += d;
        if (data.includes('\r\n\r\n')) {
          resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(data)[1]), socket, rest: data.slice(data.indexOf('\r\n\r\n') + 4) });
        }
      });
      socket.on('error', () => resolve({ status: 0, socket }));
    });

  it('refuses an address that is not on the list, for a request and for a tunnel', async () => {
    const res = await viaProxy(`http://other.acme.test:${targetPort}/x`);
    assert.equal(res.status, 403);
    assert.match(res.body, /is not on this extension's list of allowed addresses/);
    const tunnel = await connect('other.acme.test:443');
    assert.equal(tunnel.status, 403);
    tunnel.socket.destroy();
    // The right host on another port is another address.
    assert.equal((await viaProxy(`http://erp.acme.test:${targetPort + 1}/x`)).status, 403);
    assert.equal(seen.length, 0);
  });

  it('refuses a listed name that points at the machine itself, at the metadata service, or (unless marked) at a private address', async () => {
    assert.equal((await viaProxy(`http://sneaky.acme.test:${targetPort}/latest/meta-data`)).status, 403);
    assert.equal((await viaProxy(`http://inside.acme.test:${targetPort}/`)).status, 403);
    assert.equal((await viaProxy(`http://gone.acme.test:${targetPort}/`)).status, 403);
    names['erp.acme.test'] = ['127.0.0.1'];
    assert.equal((await viaProxy(`http://erp.acme.test:${targetPort}/`)).status, 403);
    assert.equal(seen.length, 0);
    const why = log.filter((e) => e.verdict === 'refused').map((e) => e.why);
    assert.ok(why.includes('an address that is never allowed'));
    assert.ok(why.includes('a private address'));
    assert.ok(why.includes('does not resolve'));
  });

  it('is not a proxy for anything else: a relative address or another scheme is a bad request', async () => {
    const res = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: proxyPort, path: '/etc/passwd' }, (r) => resolve(r.statusCode)));
    assert.equal(res, 400);
    assert.equal((await connect('no-port')).status, 403);
  });

  it('lets a listed address through, as itself, and records it', async () => {
    // Loopback is refused always, so the stand-in for the customer's system listens on this machine's network address.
    const direct = http.createServer((req, res) => res.end('ok'));
    await new Promise((ok) => direct.listen(0, '0.0.0.0', ok));
    const lan = Object.values((await import('node:os')).networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal)?.address;
    if (!lan) return direct.close(); // a machine with no network: the decisions above are what matter
    const port = direct.address().port;
    const forwarding = createProxy({ allow: parseAllow(`erp.acme.test:${port}=private`), log: (e) => log.push(e), resolve: async () => [lan] });
    await new Promise((ok) => forwarding.listen(0, '127.0.0.1', ok));
    const p = forwarding.address().port;
    try {
      const body = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: p, path: `http://erp.acme.test:${port}/orders?id=7`, headers: { host: `erp.acme.test:${port}`, 'proxy-authorization': 'Basic c2VjcmV0' } }, (res) => {
          let text = '';
          res.on('data', (d) => (text += d));
          res.on('end', () => resolve(text));
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(body, 'ok');
      assert.ok(log.some((e) => e.verdict === 'allowed' && e.host === 'erp.acme.test' && e.address === lan));
      // And as a tunnel, which is how HTTPS goes.
      const socket = net.connect(p, '127.0.0.1');
      const reply = await new Promise((resolve) => {
        let data = '';
        socket.on('connect', () => socket.write(`CONNECT erp.acme.test:${port} HTTP/1.1\r\n\r\n`));
        socket.on('data', (d) => {
          data += d;
          if (/Connection Established\r\n\r\n$/.test(data)) socket.write(`GET /t HTTP/1.1\r\nhost: erp.acme.test\r\nconnection: close\r\n\r\n`);
          if (data.endsWith('ok')) resolve(data);
        });
      });
      assert.match(reply, /^HTTP\/1\.1 200 Connection Established/);
      socket.destroy();
    } finally {
      forwarding.close();
      direct.close();
    }
  });
});
