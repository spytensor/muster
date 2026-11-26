import { createServer, type Server, type Socket } from "node:net";
import { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HOSTS,
  Egress,
  greetingHost,
  hostEntry,
  hostList,
  isPublic,
  type Lookup,
} from "./egress.js";
import { BadWire, go, gone, hello, piece, pieces, Reader } from "./wire.js";

/** The first thing a TLS client says to a host of this name: a real greeting, from Node's own TLS. */
export function greeting(host: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const wire = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, done) {
        resolve(Buffer.from(chunk));
        done();
      },
    });
    const socket = tlsConnect({ socket: wire, servername: host });
    socket.on("error", () => {});
  });
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});
/** Something out on the internet, as far as the test goes: it keeps what it is sent and answers. */
async function upstream() {
  const got: Buffer[] = [];
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("data", (chunk) => {
      got.push(chunk);
      socket.write("answer");
    });
    socket.on("error", () => {});
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { port, got, sockets };
}

/** A run's side of one connection: what it was sent back, and whether it was closed. */
function client(egress: Egress) {
  const back: Buffer[] = [];
  let closed = false;
  const tunnel = egress.tunnel(
    async (bytes) => {
      back.push(Buffer.from(bytes));
    },
    () => {
      closed = true;
    },
  );
  return {
    tunnel,
    text: () => Buffer.concat(back).toString("latin1"),
    closed: () => closed,
    ask: (host: string, port = 443) =>
      tunnel.data(Buffer.from(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)),
  };
}
const until = async (when: () => boolean) => {
  for (let i = 0; i < 200 && !when(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(when()).toBe(true);
};
/** Every name is somewhere public, and every connection lands on the test's own server. */
const world = (port: number, lookup?: Lookup) => {
  const looked: string[] = [];
  const dialled: string[] = [];
  return {
    looked,
    dialled,
    options: {
      lookup: (async (host) => {
        looked.push(host);
        return lookup ? lookup(host) : [{ address: "93.184.216.34", family: 4 }];
      }) as Lookup,
      connect: (address: string, to: number) => {
        dialled.push(`${address}:${to}`);
        const { connect } = require("node:net") as typeof import("node:net");
        return connect({ host: "127.0.0.1", port });
      },
    },
  };
};

describe("the hosts a run may reach", () => {
  it("are names: no address, no port, no path, nothing twice, fifty at most", () => {
    expect(hostEntry("PyPI.org.")).toBe("pypi.org");
    expect(hostEntry("*.Example.com")).toBe("*.example.com");
    for (const not of [
      "10.0.0.1",
      "localhost",
      "pypi.org:443",
      "http://pypi.org",
      "a b.com",
      "1.2.3.4",
      "*.",
      "[::1]",
      "169.254.169.254",
      "x.123",
      7,
      null,
    ])
      expect(hostEntry(not)).toBeNull();
    expect(hostList(["pypi.org", "PYPI.ORG", "10.0.0.1", "*.corp.example"])).toEqual([
      "pypi.org",
      "*.corp.example",
    ]);
    expect(hostList(Array.from({ length: 80 }, (_, n) => `h${n}.example.com`)).length).toBe(50);
    expect(hostList("pypi.org")).toEqual([]);
    expect(DEFAULT_HOSTS).toEqual(["pypi.org", "files.pythonhosted.org", "registry.npmjs.org"]);
  });

  it("are never this machine or a network of its own, however the address is written", () => {
    for (const inside of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fe80::1",
      "fd00:ec2::254",
      "::ffff:10.0.0.1",
      "0:0:0:0:0:ffff:a00:1",
      "64:ff9b::a00:1",
      "2002:a00:1::",
      "ff02::1",
      "not an address",
    ])
      expect(isPublic(inside), inside).toBe(false);
    for (const out of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111"])
      expect(isPublic(out), out).toBe(true);
  });
});

describe("an address that is really another", () => {
  it("is refused: an IPv4 address written as an IPv6 one, a tunnel's, an example's, and this machine's own", () => {
    for (const inside of [
      "::10.0.0.1",
      "::ffff:8.8.8.8",
      "::ffff:808:808",
      "::808:808",
      "64:ff9b::808:808",
      "64:ff9b:1::1",
      "2001::1",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "2002:808:808::1",
      "2001:2::1",
      "2001:10::1",
      "2001:db8::1",
      "3fff::1",
      "100::1",
      "fec0::1",
      "192.88.99.1",
      "198.19.0.1",
      "233.252.0.1",
      "::ffff:1.2.3.999",
      "1::2::3",
    ])
      expect(isPublic(inside, new Set()), inside).toBe(false);
    for (const out of [
      "2606:4700:4700::1111",
      "2a00:1450:4001:81b::200e",
      "8.8.8.8",
      "2001:4860:4860::8888",
    ])
      expect(isPublic(out, new Set()), out).toBe(true);
    // One of this machine's own addresses is not out on the internet, public as it may look.
    expect(isPublic("203.0.114.7", new Set(["203.0.114.7"]))).toBe(false);
    expect(isPublic("2606:4700::1", new Set(["2606:4700::1"]))).toBe(false);
    expect(isPublic("203.0.114.7", new Set())).toBe(true);
  });
});

describe("a TLS greeting", () => {
  it("names its host, and is waited for until it is whole", async () => {
    const bytes = await greeting("pypi.org");
    expect(greetingHost(bytes)).toBe("pypi.org");
    expect(greetingHost(bytes.subarray(0, 40))).toBeNull();
    expect(greetingHost(Buffer.from("GET / HTTP/1.1\r\n\r\n"))).toBe(false);
  });
});

describe("what a run asks to reach", () => {
  it("is let through to a host on the list, at the address that was looked at, and counted", async () => {
    const out = await upstream();
    const at = world(out.port);
    const egress = new Egress({ hosts: ["pypi.org"], ...at.options });
    const run = client(egress);
    run.ask("pypi.org");
    await until(() => run.text().includes("200 Connection Established"));
    expect(at.looked).toEqual(["pypi.org"]);
    // To the address the name had, not to the name: it is not asked a second time.
    expect(at.dialled).toEqual(["93.184.216.34:443"]);
    const first = await greeting("pypi.org");
    run.tunnel.data(first);
    await until(() => run.text().endsWith("answer"));
    expect(Buffer.concat(out.got).equals(first)).toBe(true);
    run.tunnel.data(Buffer.from("more"));
    await until(() => Buffer.concat(out.got).length === first.length + 4);
    expect(egress.reached()).toMatchObject([
      { host: "pypi.org", ok: true, times: 1, up: first.length + 4 },
    ]);
    expect(egress.reached()[0]?.down).toBeGreaterThan(0);
    egress.end();
    expect(run.closed()).toBe(true);
  });

  it("is refused for a host that is not on the list, an address, another port or plain http", async () => {
    const out = await upstream();
    const at = world(out.port);
    const egress = new Egress({ hosts: ["pypi.org", "*.corp.example"], ...at.options });
    const refused = async (ask: (run: ReturnType<typeof client>) => void, why: RegExp) => {
      const run = client(egress);
      ask(run);
      await until(() => run.closed());
      expect(run.text()).toMatch(/^HTTP\/1\.1 403 Forbidden/);
      expect(run.text()).toMatch(why);
    };
    await refused((run) => run.ask("evil.example"), /not on the organization's list/);
    await refused((run) => run.ask("169.254.169.254"), /an address is not passed on/);
    await refused((run) => run.ask("pypi.org", 22), /only port 443/);
    await refused((run) => run.ask("corp.example"), /not on the organization's list/);
    await refused(
      (run) => run.tunnel.data(Buffer.from("GET http://pypi.org/simple/ HTTP/1.1\r\n\r\n")),
      /only https/,
    );
    // Nothing was looked up or dialled for any of them.
    expect(at.looked).toEqual([]);
    expect(at.dialled).toEqual([]);
    expect(out.sockets.length).toBe(0);
    // One line for a host and a reason, with how often.
    const again = client(egress);
    again.ask("evil.example");
    await until(() => again.closed());
    expect(egress.reached().map((one) => [one.host, one.ok, one.times, one.why])).toEqual([
      ["evil.example", false, 2, "this host is not on the organization's list"],
      ["169.254.169.254", false, 1, "an address is not passed on, only a name"],
      ["pypi.org", false, 1, "only port 443 is passed on"],
      ["corp.example", false, 1, "this host is not on the organization's list"],
      ["pypi.org", false, 1, "only https is passed on"],
    ]);
    // A host under a starred name is on the list.
    const run = client(egress);
    run.ask("git.corp.example");
    await until(() => run.text().includes("200 Connection Established"));
    egress.end();
  });

  it("is refused when the name leads inward, even if only one of its addresses does", async () => {
    const out = await upstream();
    for (const answers of [
      [{ address: "10.0.0.5", family: 4 }],
      [
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
      [{ address: "::1", family: 6 }],
      [],
    ]) {
      const at = world(out.port, async () => answers);
      const egress = new Egress({ hosts: ["pypi.org"], ...at.options });
      const run = client(egress);
      run.ask("pypi.org");
      await until(() => run.closed());
      expect(run.text()).toMatch(/^HTTP\/1\.1 403/);
      expect(at.dialled).toEqual([]);
    }
    expect(out.sockets.length).toBe(0);
  });

  it("is not fooled by a name that answers differently the second time", async () => {
    const out = await upstream();
    let asked = 0;
    const at = world(out.port, async () => {
      asked += 1;
      return [{ address: asked === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }];
    });
    const egress = new Egress({ hosts: ["pypi.org"], ...at.options });
    const run = client(egress);
    run.ask("pypi.org");
    await until(() => run.text().includes("200"));
    // Looked up once, and connected to what that one answer said.
    expect(asked).toBe(1);
    expect(at.dialled).toEqual(["93.184.216.34:443"]);
    egress.end();
  });

  it("ends a connection opened to an allowed host and then used for another", async () => {
    const out = await upstream();
    const at = world(out.port);
    const egress = new Egress({ hosts: ["files.pythonhosted.org"], ...at.options });
    const run = client(egress);
    run.ask("files.pythonhosted.org");
    await until(() => run.text().includes("200"));
    run.tunnel.data(await greeting("attacker.example"));
    await until(() => run.closed());
    // Nothing of it went out.
    expect(Buffer.concat(out.got).length).toBe(0);
    expect(egress.reached()).toMatchObject([
      { host: "files.pythonhosted.org", ok: false, why: expect.stringContaining("another host") },
    ]);
    // Nor does something that is no greeting at all.
    const plain = client(egress);
    plain.ask("files.pythonhosted.org");
    await until(() => plain.text().includes("200"));
    plain.tunnel.data(
      Buffer.from("POST /upload HTTP/1.1\r\nHost: files.pythonhosted.org\r\n\r\nsecret"),
    );
    await until(() => plain.closed());
    expect(Buffer.concat(out.got).length).toBe(0);
  });

  it("stops what a run sends out at what a run may send", async () => {
    const out = await upstream();
    const at = world(out.port);
    const first = await greeting("pypi.org");
    const egress = new Egress({
      hosts: ["pypi.org"],
      ...at.options,
      limits: { up: first.length + 10 },
    });
    const run = client(egress);
    run.ask("pypi.org");
    await until(() => run.text().includes("200"));
    run.tunnel.data(first);
    run.tunnel.data(Buffer.alloc(64, 1));
    await until(() => run.closed());
    // What passed the limit never went out: at most the greeting did.
    expect(Buffer.concat(out.got).length).toBeLessThanOrEqual(first.length);
    expect(egress.reached()[0]?.why).toMatch(/more was sent out/);
  });

  it("reaches nothing when its list is empty", async () => {
    const egress = new Egress({ hosts: [] });
    expect(egress.any).toBe(false);
    const run = client(egress);
    run.ask("pypi.org");
    await until(() => run.closed());
    expect(run.text()).toMatch(/403/);
  });
});

describe("how many connections a run may have", () => {
  it("is exactly as many at once as it may, and a refused one asks nothing more", async () => {
    const out = await upstream();
    const at = world(out.port);
    const egress = new Egress({ hosts: ["pypi.org"], ...at.options, limits: { atOnce: 2 } });
    const first = client(egress);
    const second = client(egress);
    first.ask("pypi.org");
    second.ask("pypi.org");
    await until(() => first.text().includes("200") && second.text().includes("200"));
    // A third is one too many, while the two are open.
    const third = client(egress);
    third.ask("pypi.org");
    await until(() => third.closed());
    expect(third.text()).toMatch(/403[\s\S]*too many connections at once/);
    expect(at.dialled.length).toBe(2);
    // One ends: there is room for one more, and for no more than one.
    first.tunnel.end();
    const fourth = client(egress);
    fourth.ask("pypi.org");
    await until(() => fourth.text().includes("200"));
    const fifth = client(egress);
    fifth.ask("pypi.org");
    await until(() => fifth.closed());
    expect(at.dialled.length).toBe(3);

    // Refused, and then asked again on the same connection before it is closed: the
    // second asking is not read, whatever it asks for.
    const sly = client(egress);
    sly.tunnel.data(
      Buffer.from("CONNECT evil.example:443 HTTP/1.1\r\n\r\nCONNECT pypi.org:443 HTTP/1.1\r\n\r\n"),
    );
    sly.ask("pypi.org");
    await until(() => sly.closed());
    expect(sly.text().match(/HTTP\/1\.1/g)?.length).toBe(1);
    expect(sly.text()).toMatch(/^HTTP\/1\.1 403/);
    expect(at.dialled.length).toBe(3);
    egress.end();
  });
});

describe("how fast a connection's bytes go", () => {
  it("lets a run send more only as the host takes what it sent, and at once for what is read here", async () => {
    // A host that takes nothing until it is told to.
    const sockets: Socket[] = [];
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.pause();
      socket.on("error", () => {});
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const at = world((server.address() as { port: number }).port);
    const egress = new Egress({ hosts: ["pypi.org"], ...at.options });
    let taken = 0;
    const back: Buffer[] = [];
    const tunnel = egress.tunnel(
      async (bytes) => void back.push(Buffer.from(bytes)),
      () => {},
      (count) => {
        taken += count;
      },
    );
    const asking = Buffer.from("CONNECT pypi.org:443 HTTP/1.1\r\n\r\n");
    tunnel.data(asking);
    await until(() => Buffer.concat(back).toString().includes("200 Connection Established"));
    const first = await greeting("pypi.org");
    tunnel.data(first);
    // What was read here (the asking, the greeting) is answered for as it comes.
    expect(taken).toBe(asking.length + first.length);
    // Eight megabytes to a host that reads none of it: it is not said to have gone on.
    const much = Buffer.alloc(8 * 1024 * 1024, 7);
    for (let from = 0; from < much.length; from += 64 * 1024)
      tunnel.data(much.subarray(from, from + 64 * 1024));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(taken - asking.length - first.length).toBeLessThan(much.length);
    const stuck = taken;
    // The host reads: the rest goes, and all of it is answered for.
    let got = 0;
    sockets[0]?.on("data", (chunk) => {
      got += chunk.length;
    });
    sockets[0]?.resume();
    await until(() => taken === asking.length + first.length + much.length);
    expect(taken).toBeGreaterThan(stuck);
    await until(() => got === first.length + much.length);
    egress.end();
  });
});

describe("the pieces a run and this service pass each other", () => {
  it("say how many more bytes of a connection may be sent, in four bytes and no other way", () => {
    const got: [string, number, number][] = [];
    const reader = new Reader((kind, id, bytes) => {
      if (kind === "W") got.push([kind, id, gone(bytes)]);
    });
    reader.push(Buffer.concat([hello(), go(3, 65_536), go(9, 1)]));
    expect(got).toEqual([
      ["W", 3, 65_536],
      ["W", 9, 1],
    ]);
    expect(() => gone(Uint8Array.of(1, 2, 3))).toThrow(BadWire);
    expect(() => gone(new Uint8Array(5))).toThrow(BadWire);
  });

  it("are read whole however they arrive, and nothing else is taken for one", () => {
    const got: [string, number, string][] = [];
    const read = () =>
      new Reader((kind, id, bytes) => got.push([kind, id, Buffer.from(bytes).toString()]));
    const all = Buffer.concat([
      hello(),
      piece("O", 0, Buffer.from("printed")),
      piece("C", 7),
      ...pieces("D", 7, Buffer.from("abc")),
      piece("R", 0, Buffer.from("files")),
      piece("Z", 0),
    ]);
    // A byte at a time.
    const slow = read();
    for (const byte of all) slow.push(Uint8Array.of(byte));
    expect(slow.ended).toBe(true);
    expect(got).toEqual([
      ["O", 0, "printed"],
      ["C", 7, ""],
      ["D", 7, "abc"],
      ["R", 0, "files"],
      ["Z", 0, ""],
    ]);
    expect(() => slow.push(Uint8Array.of(1))).toThrow(BadWire);
    // Not the four letters; a kind there is none of; a piece longer than a piece; more after the end.
    expect(() => read().push(Buffer.from("MSB1....."))).toThrow(BadWire);
    expect(() => read().push(Buffer.concat([hello(), piece("Q", 0)]))).toThrow(BadWire);
    const long = Buffer.concat([hello(), piece("O", 0)]);
    long.writeUInt32BE(70_000, 4 + 5);
    expect(() => read().push(long)).toThrow(BadWire);
    expect(() => read().push(Buffer.concat([all, Buffer.from("x")]))).toThrow(BadWire);
    expect(() => piece("O", 0, new Uint8Array(70_000))).toThrow(BadWire);
    expect([...pieces("D", 1, new Uint8Array(150_000))].length).toBe(3);
  });
});
