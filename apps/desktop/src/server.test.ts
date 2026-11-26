import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtInServer, cleanServer, feedUrl } from "./server.js";

describe("the server a build is for", () => {
  const file = (text: string) => {
    const path = join(mkdtempSync(join(tmpdir(), "muster-desktop-")), "server.json");
    writeFileSync(path, text);
    return path;
  };

  it("is read from the file beside the code, in the one form the app uses", () => {
    expect(builtInServer(file('{"server":"https://muster.example.com/app?x=1"}'))).toBe(
      "https://muster.example.com",
    );
    expect(builtInServer(file('{"server":"http://localhost:5173"}'))).toBe("http://localhost:5173");
  });

  it("is none when the file is missing, broken, or names no address the app would open", () => {
    expect(builtInServer(join(tmpdir(), "no-such-muster-file.json"))).toBeNull();
    expect(builtInServer(file("not json"))).toBeNull();
    expect(builtInServer(file("{}"))).toBeNull();
    expect(builtInServer(file('{"server":7}'))).toBeNull();
    // Plain http is only for a server on this machine.
    expect(builtInServer(file('{"server":"http://muster.example.com"}'))).toBeNull();
    expect(builtInServer(file('{"server":"javascript:alert(1)"}'))).toBeNull();
  });

  it("the file this repository ships names no server, so the app asks", () => {
    expect(builtInServer(join(__dirname, "..", "server.json"))).toBeNull();
  });

  it("asks its server for a newer build of itself, saying what it is", () => {
    expect(feedUrl("https://muster.example.com", "darwin", "arm64", "0.1.0")).toBe(
      "https://muster.example.com/desktop/update?platform=darwin&arch=arm64&version=0.1.0",
    );
    expect(feedUrl("http://localhost:5173/", "darwin", "x64", "1.2.3")).toBe(
      "http://localhost:5173/desktop/update?platform=darwin&arch=x64&version=1.2.3",
    );
  });
});
