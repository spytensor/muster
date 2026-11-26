import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { uploadFile } from "./files";

afterEach(() => vi.unstubAllGlobals());
const stored = { id: "1", name: "a.csv" };
const answer = (status = 200, body: unknown = stored) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("sending a file", () => {
  it("reads the file first, and says so when the computer cannot read it", async () => {
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    // As a file kept in iCloud whose content is not on the disk, or a folder dropped in.
    const unreadable = new File(["x"], "cloud.csv");
    unreadable.arrayBuffer = () => Promise.reject(new DOMException("gone", "NotReadableError"));
    await expect(uploadFile(unreadable)).rejects.toMatchObject({ code: "file_not_readable" });
    // The server was never asked: it is not the server that could not be reached.
    expect(fetched).not.toHaveBeenCalled();
  });

  it("sends what it read, once", async () => {
    const fetched = vi.fn().mockResolvedValueOnce(answer());
    vi.stubGlobal("fetch", fetched);
    await expect(
      uploadFile(new File(["a,b\n1,2\n"], "a b.csv", { type: "text/csv" })),
    ).resolves.toEqual(stored);
    const [address, options] = fetched.mock.calls[0] as [string, RequestInit];
    expect(address).toBe("/api/app/files?name=a%20b.csv");
    expect(new TextDecoder().decode(options.body as ArrayBuffer)).toBe("a,b\n1,2\n");
    expect(options.headers).toEqual({ "content-type": "text/csv" });
  });

  it("says the connection dropped without sending again, and passes on what the server refuses", async () => {
    const dropped = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", dropped);
    await expect(uploadFile(new File(["x"], "a.csv"))).rejects.toMatchObject({ code: "network" });
    // Sent again, a file whose first sending had arrived would be kept twice.
    expect(dropped).toHaveBeenCalledTimes(1);
    const refused = vi
      .fn()
      .mockResolvedValue(answer(415, { error: { code: "unsupported_file", message: "" } }));
    vi.stubGlobal("fetch", refused);
    const failure = await uploadFile(new File(["x"], "a.exe")).catch((error) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.code).toBe("unsupported_file");
  });

  it("does not blame the file when reading it fails for another reason, nor read one too large to be taken", async () => {
    const fetched = vi.fn().mockImplementation(async () => answer());
    vi.stubGlobal("fetch", fetched);
    const heavy = new File(["x"], "heavy.csv");
    heavy.arrayBuffer = () => Promise.reject(new RangeError("Array buffer allocation failed"));
    await expect(uploadFile(heavy)).resolves.toEqual(stored);
    // Sent as the file itself.
    expect((fetched.mock.calls[0] as [string, RequestInit])[1].body).toBe(heavy);
    const huge = new File(["x"], "huge.mov");
    Object.defineProperty(huge, "size", { value: 2 * 1024 ** 3 });
    const read = vi.fn();
    huge.arrayBuffer = read;
    await uploadFile(huge);
    expect(read).not.toHaveBeenCalled();
  });
});
