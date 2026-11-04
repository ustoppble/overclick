import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Where the server may point git on a project's behalf. `repo_url` is data a
 * person typed, and delivery verification turns it into a network request from
 * the server, so only an https remote that resolves to a public address is
 * followed. File paths, git:, ssh:, ext:: and plain http never reach git.
 */

export type PinnedRemote = { host: string; port: number; address: string };

/** The remote as a URL, or null when it is not a plain https remote without credentials. */
export function parseHttpsRemote(raw: string): URL | null {
  const value = raw.trim();
  if (!value || !/^https:\/\//i.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname) return null;
  // A credential in the URL would be sent to the host and could leak in logs.
  if (url.username || url.password) return null;
  return url;
}

function ipv4Bytes(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : null;
}

function privateIpv4(bytes: number[]): boolean {
  const [a, b, c] = bytes as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** Eight 16-bit groups of an IPv6 address, an embedded IPv4 tail included. */
function ipv6Groups(value: string): number[] | null {
  let text = value.toLowerCase().split("%")[0] ?? "";
  const tail = text.lastIndexOf(":") >= 0 ? text.slice(text.lastIndexOf(":") + 1) : "";
  if (tail.includes(".")) {
    const v4 = ipv4Bytes(tail);
    if (!v4) return null;
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16);
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16);
    text = `${text.slice(0, text.lastIndexOf(":") + 1)}${hi}:${lo}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...rest].map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN,
  );
  return groups.length === 8 && groups.every((g) => g >= 0) ? groups : null;
}

function privateIpv6(g: number[]): boolean {
  const embedded = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  const zeroPrefix = g.slice(0, 5).every((x) => x === 0);
  if (zeroPrefix && g[5] === 0 && g[6] === 0 && g[7]! <= 1) return true; // :: and ::1
  if (zeroPrefix && g[5] === 0xffff) return privateIpv4(embedded(g[6]!, g[7]!)); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return privateIpv4(embedded(g[6]!, g[7]!)); // NAT64
  }
  if (g[0] === 0x100 && g.slice(1, 4).every((x) => x === 0)) return true; // 100::/64
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true; // Teredo, documentation
  if (g[0] === 0x2002) return true; // 6to4
  return (
    (g[0]! & 0xfe00) === 0xfc00 || // fc00::/7
    (g[0]! & 0xffc0) === 0xfe80 || // fe80::/10
    (g[0]! & 0xffc0) === 0xfec0 || // fec0::/10
    (g[0]! & 0xff00) === 0xff00 // multicast
  );
}

/** True for anything but a public unicast address; unreadable input counts as not public. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const bytes = ipv4Bytes(address);
    return !bytes || privateIpv4(bytes);
  }
  if (family === 6) {
    const groups = ipv6Groups(address);
    return !groups || privateIpv6(groups);
  }
  return true;
}

async function defaultLookup(host: string): Promise<string[]> {
  const rows = await dnsLookup(host, { all: true, verbatim: true });
  return rows.map((row) => row.address);
}

/**
 * Resolves the remote's host and returns an address to pin git to, or null
 * when any answer is not public (one private record is enough to refuse: the
 * resolver could hand it to git). The caller passes the pin on, so git does not
 * resolve the name a second time and cannot be rebound to an internal address.
 */
export async function resolvePublicRemote(
  url: URL,
  lookup: (host: string) => Promise<string[]> = defaultLookup,
): Promise<PinnedRemote | null> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port ? Number(url.port) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (isIP(host)) {
    return isPrivateAddress(host) ? null : { host, port, address: host };
  }
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    return null;
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) return null;
  return { host, port, address: addresses[0]! };
}

/** Config git runs with: https only, no redirects, no credential helper, a pinned address. */
export function hardenedGitConfig(pin: PinnedRemote): string[] {
  const address = pin.address.includes(":") ? `[${pin.address}]` : pin.address;
  return [
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
    "-c", "http.followRedirects=false",
    "-c", "credential.helper=",
    "-c", `http.curloptResolve=${pin.host}:${pin.port}:${address}`,
  ];
}
