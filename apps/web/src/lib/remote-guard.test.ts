import { describe, expect, it } from "vitest";
import { DELIVERY_UNVERIFIED_WARNING, verifyDelivery } from "./delivery-verification";
import { isPrivateAddress, parseHttpsRemote, resolvePublicRemote } from "./remote-guard";

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1", "127.8.9.10", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1", "255.255.255.255", "192.0.0.1", "198.18.0.1",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3", "64:ff9b::7f00:1",
  ])("treats %s as not public", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "140.82.112.3", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("treats %s as public", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it("refuses what it cannot read as an address", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });
});

describe("parseHttpsRemote", () => {
  it("accepts a plain https remote", () => {
    expect(parseHttpsRemote("https://git.example.com/team/repo.git")?.hostname).toBe("git.example.com");
  });

  it.each([
    "file:///etc", "git://git.example.com/r", "ext::sh -c id", "ssh://git@git.example.com/r", "http://git.example.com/r",
    "ftp://git.example.com/r", "https://user:secret@git.example.com/r", "https://user@git.example.com/r",
    "./local.git", "/srv/repo.git", "git@git.example.com:team/repo.git", "", "https://", "-oProxyCommand=id",
  ])("rejects %s", (raw) => {
    expect(parseHttpsRemote(raw)).toBeNull();
  });
});

describe("resolvePublicRemote", () => {
  const url = new URL("https://git.example.com/team/repo.git");

  it("pins the first public address", async () => {
    const pinned = await resolvePublicRemote(url, async () => ["140.82.112.3"]);
    expect(pinned).toEqual({ host: "git.example.com", port: 443, address: "140.82.112.3" });
  });

  it("uses the explicit port", async () => {
    const pinned = await resolvePublicRemote(new URL("https://git.example.com:8443/r"), async () => ["8.8.8.8"]);
    expect(pinned?.port).toBe(8443);
  });

  it.each([
    [["127.0.0.1"]], [["10.0.0.5"]], [["169.254.169.254"]], [["::1"]], [["fd00::1"]],
    [["140.82.112.3", "10.0.0.5"]], [[]],
  ])("refuses a name that resolves to %j", async (addresses) => {
    expect(await resolvePublicRemote(url, async () => addresses)).toBeNull();
  });

  it("refuses an IP literal that is private, without a lookup", async () => {
    let looked = false;
    const pinned = await resolvePublicRemote(new URL("https://10.1.2.3/r"), async () => {
      looked = true;
      return ["8.8.8.8"];
    });
    expect(pinned).toBeNull();
    expect(looked).toBe(false);
  });

  it("refuses when the lookup fails", async () => {
    expect(await resolvePublicRemote(url, async () => { throw new Error("ENOTFOUND"); })).toBeNull();
  });
});

describe("verifyDelivery refuses to reach where it must not", () => {
  const never = async (): Promise<string> => {
    throw new Error("git must not run");
  };
  const lookupPublic = async () => ["140.82.112.3"];

  it.each(["git://git.example.com/r", "ext::sh -c id", "ssh://git@git.example.com/r", "http://git.example.com/r", "https://user:secret@git.example.com/r"])(
    "never runs git for %s",
    async (repoUrl) => {
      const result = await verifyDelivery({ repoUrl, commit: "abc123", branch: "main" }, { git: never, lookup: lookupPublic });
      expect(result.status).toBe("unverified");
      expect(result.warning).not.toContain("secret");
    },
  );

  it.each(["file:///etc", "/srv/repo.git", "./repo.git"])("does not treat a local checkout (%s) as a remote to check", async (repoUrl) => {
    const result = await verifyDelivery({ repoUrl, commit: "abc123", branch: "main" }, { git: never, lookup: lookupPublic });
    expect(result).toEqual({ status: null, unverified: false, warning: null });
  });

  it.each(["127.0.0.1", "10.0.0.5", "169.254.169.254", "::1"])("never runs git when the host resolves to %s", async (address) => {
    const result = await verifyDelivery(
      { repoUrl: "https://git.internal.example/team/repo.git", commit: "abc123", branch: "main" },
      { git: never, lookup: async () => [address] },
    );
    expect(result.status).toBe("unverified");
  });

  it("runs git only over https, pinned to the resolved address, with no redirects and no credentials", async () => {
    const calls: string[][] = [];
    const result = await verifyDelivery(
      { repoUrl: "https://git.example.com/team/repo.git", commit: "abc123", branch: "main" },
      {
        lookup: lookupPublic,
        git: async (args) => {
          calls.push(args);
          return args.includes("ls-remote") ? "abc123\trefs/heads/main\n" : "";
        },
      },
    );
    expect(result.status).toBe("verified");
    const flat = calls[0]!.join(" ");
    expect(flat).toContain("protocol.allow=never");
    expect(flat).toContain("protocol.https.allow=always");
    expect(flat).toContain("http.followRedirects=false");
    expect(flat).toContain("credential.helper=");
    expect(flat).toContain("http.curloptResolve=git.example.com:443:140.82.112.3");
    expect(calls[0]).toContain("ls-remote");
    expect(DELIVERY_UNVERIFIED_WARNING).toBeTruthy();
  });
});
