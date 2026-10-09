#!/usr/bin/env node
/**
 * The way out for one customer's extension.
 *
 * An extension's container has no route to anything. When a customer needs
 * their code to call their own systems, it is given this proxy, which lets
 * through only the addresses agreed with them and records every attempt.
 *
 *   ALLOW=api.acme.com,erp.acme.com:8443,erp.internal:8080=private
 *
 * An entry is a host name and a port (443 when left out). A name that resolves
 * to a private address is refused unless its entry says `=private` (a system
 * reached over a private link). Addresses of the machine itself, of the
 * cloud's metadata service and of the network the proxy shares with the
 * product (NEVER) are refused always.
 */
import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** "a.com, b.com:8443=private" -> Map("a.com:443" -> { private: false }, ...). Throws on anything it does not understand. */
export function parseAllow(text) {
  const allow = new Map();
  for (const raw of String(text ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const isPrivate = raw.endsWith('=private');
    const [host, port = '443', ...rest] = (isPrivate ? raw.slice(0, -'=private'.length) : raw).split(':');
    if (rest.length || !HOST.test(host) || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error(`"${raw}" is not host, host:port or host:port=private`);
    allow.set(`${host}:${Number(port)}`, { private: isPrivate });
  }
  return allow;
}

const never = new net.BlockList();
never.addSubnet('127.0.0.0', 8); // this machine
never.addSubnet('169.254.0.0', 16); // link-local, where clouds keep instance credentials
never.addSubnet('0.0.0.0', 8);
never.addSubnet('224.0.0.0', 4); // multicast
never.addAddress('::1', 'ipv6');
never.addAddress('::', 'ipv6');
never.addSubnet('fe80::', 10, 'ipv6');
never.addSubnet('ff00::', 8, 'ipv6');
const privateRanges = new net.BlockList();
privateRanges.addSubnet('10.0.0.0', 8);
privateRanges.addSubnet('172.16.0.0', 12);
privateRanges.addSubnet('192.168.0.0', 16);
privateRanges.addSubnet('100.64.0.0', 10); // carrier-grade NAT
privateRanges.addSubnet('fc00::', 7, 'ipv6');

/**
 * More ranges that are never to be reached, whatever the list says: "10.1.0.0/16,...".
 * The proxy is started with the network it shares with the extension, the API and the worker,
 * so that it can only ever lead outwards.
 */
export function neverReach(cidrs) {
  for (const cidr of String(cidrs ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [net_, bits] = cidr.split('/');
    if (!net.isIP(net_) || !/^\d{1,3}$/.test(bits ?? '')) throw new Error(`"${cidr}" is not a network (address/bits)`);
    never.addSubnet(net_, Number(bits), net.isIPv6(net_) ? 'ipv6' : 'ipv4');
  }
}

/** Why an address may not be connected to, or '' when it may. */
export function refusal(address, allowPrivate) {
  // "::ffff:10.0.0.1" is 10.0.0.1 in IPv6 clothing.
  const ip = address.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
  const family = net.isIPv6(ip) ? 'ipv6' : 'ipv4';
  if (!net.isIP(ip)) return 'not an address';
  if (never.check(ip, family)) return 'an address that is never allowed';
  if (!allowPrivate && privateRanges.check(ip, family)) return 'a private address';
  return '';
}

/**
 * The proxy. `resolve` turns a host name into addresses (replaceable in tests);
 * `log` receives one object per attempt.
 */
export function createProxy({ allow, log = () => {}, resolve = async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address), connectTimeoutMs = 10_000 }) {
  /** Decides one attempt. Returns the address to connect to, or a reason it was refused. */
  async function decide(host, port) {
    const name = String(host ?? '').toLowerCase();
    const entry = allow.get(`${name}:${port}`);
    const say = (verdict, extra = {}) => log({ at: new Date().toISOString(), host: name, port, verdict, ...extra });
    if (!entry) {
      say('refused', { why: 'not on the list' });
      return { refused: `${name}:${port} is not on this extension's list of allowed addresses` };
    }
    // Named in the list, so never a bare address: what it points at is checked each time, and that address is the one used.
    let addresses;
    try {
      addresses = net.isIP(name) ? [name] : await resolve(name);
    } catch {
      say('refused', { why: 'does not resolve' });
      return { refused: `${name} could not be found` };
    }
    for (const address of addresses) {
      const why = refusal(address, entry.private);
      if (!why) {
        say('allowed', { address });
        return { address };
      }
      say('refused', { why, address });
    }
    return { refused: `${name} points at an address that is not allowed` };
  }

  const server = http.createServer(async (req, res) => {
    // A plain http:// request arrives whole, with the full address on its first line.
    let url;
    try {
      url = new URL(req.url);
      if (url.protocol !== 'http:') throw new Error();
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('This is a proxy: ask for a full http:// address, or CONNECT.');
      return;
    }
    const port = Number(url.port) || 80;
    const verdict = await decide(url.hostname, port);
    if (verdict.refused) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end(verdict.refused);
      return;
    }
    const headers = { ...req.headers, host: url.host };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const out = http.request({ host: verdict.address, port, method: req.method, path: `${url.pathname}${url.search}`, headers, timeout: connectTimeoutMs }, (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
    });
    out.on('timeout', () => out.destroy(new Error('timeout')));
    out.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502, { 'content-type': 'text/plain' }).end('The address did not answer.')));
    req.pipe(out);
  });

  // HTTPS (and anything else over TLS): a tunnel to host:port, which the proxy cannot read.
  server.on('connect', async (req, socket, head) => {
    socket.on('error', () => {});
    const m = /^([^:\s]+):(\d{1,5})$/.exec(req.url ?? '');
    const verdict = m ? await decide(m[1], Number(m[2])) : { refused: 'Ask for host:port.' };
    if (verdict.refused) {
      socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(verdict.refused)}\r\nconnection: close\r\n\r\n${verdict.refused}`);
      return;
    }
    const out = net.connect({ host: verdict.address, port: Number(m[2]), timeout: connectTimeoutMs });
    out.on('timeout', () => out.destroy(new Error('timeout')));
    out.on('error', () => (socket.writable ? socket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n') : socket.destroy()));
    out.on('connect', () => {
      out.setTimeout(0);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) out.write(head);
      out.pipe(socket);
      socket.pipe(out);
    });
    socket.on('close', () => out.destroy());
  });
  return server;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const allow = parseAllow(process.env.ALLOW);
  neverReach(process.env.NEVER);
  const port = Number(process.env.PORT) || 3128;
  createProxy({ allow, log: (entry) => console.log(JSON.stringify(entry)) }).listen(port, () => console.log(JSON.stringify({ at: new Date().toISOString(), listening: port, allow: [...allow.keys()] })));
}
