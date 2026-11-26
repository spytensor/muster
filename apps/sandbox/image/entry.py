"""What runs inside a sandbox: take the working folder in, run the code, hand back what changed.

Standard input and standard output are the only way in or out: no network, no mount.
Each carries small pieces (see apps/sandbox/src/wire.ts): the folder's files in and the
changed files out (each a stream of files, apps/sandbox/src/bundle.ts), what the code
prints as it prints it, and, where the run was given hosts it may reach, the connections
it makes: a small proxy listens on this container's own loopback and passes each one out
as pieces, to be let through or refused outside (apps/sandbox/src/egress.ts). The code
runs as the same user as this script, so what goes out is not trusted by whoever reads
it; they check it again.
"""

import ctypes
import json
import os
import queue
import signal
import socket
import struct
import subprocess
import sys
import threading
import time

# Somewhere else only when this file is tried outside a container (the runner's tests).
WORK = os.environ.get("MUSTER_SANDBOX_WORK", "/work")
TMP = os.environ.get("MUSTER_SANDBOX_TMP", "/tmp")
RUN = os.path.join(WORK, ".run")
MAGIC = b"MSB1"
WIRE = b"MSX1"
PIECE = 64 * 1024
# How much of what is printed is passed on while the code runs. The whole is still kept
# for the answer, which gives its beginning and its end.
LIVE_BYTES = 220_000
PROXY_PORT = int(os.environ.get("MUSTER_SANDBOX_PROXY_PORT", "8118"))
OUT_BYTES = 256 * 1024 * 1024
OUT_FILES = 4000
SAID_BYTES = 200_000
NAME_BYTES = 400
PART_BYTES = 255


class Wire:
    """Pieces out, one at a time whoever writes them."""

    def __init__(self, out):
        self.out = out
        self.lock = threading.Lock()

    def send(self, kind, number=0, data=b""):
        with self.lock:
            at = 0
            while True:
                part = data[at : at + PIECE]
                self.out.write(kind + struct.pack(">II", number, len(part)) + part)
                at += PIECE
                if at >= len(data):
                    break
            self.out.flush()


def piece(stream):
    """The next piece handed in: its kind, its number and its bytes. None at the end."""
    head = stream.read(9)
    if len(head) != 9:
        return None
    number, size = struct.unpack(">II", head[1:])
    if size > PIECE:
        raise SystemExit("a piece handed in is too long")
    data = stream.read(size)
    if len(data) != size:
        return None
    return head[:1], number, data


class Handed:
    """The files handed in, read as one stream out of the pieces that carry them."""

    def __init__(self, stream):
        self.stream = stream
        self.held = b""
        self.over = False

    def read(self, count):
        while len(self.held) < count and not self.over:
            got = piece(self.stream)
            if got is None or got[0] == b"J":
                self.over = True
            elif got[0] == b"I":
                self.held += got[2]
        data, self.held = self.held[:count], self.held[count:]
        return data

    def finish(self):
        while not self.over:
            got = piece(self.stream)
            if got is None or got[0] == b"J":
                self.over = True


def sealed():
    """Keeps the code out of this program's own files.

    The code runs as the same user as this program, and a process may open another's
    open files through /proc unless that other has said it is not to be looked into.
    This says so (PR_SET_DUMPABLE, 0): its /proc entries then belong to root, and the
    code, which is not root and has no privileges, cannot open the pipe the pieces go out
    on and write pieces of its own. Where this cannot be said (not Linux), nothing is.
    """
    try:
        return ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0) == 0
    except (OSError, AttributeError):
        return False


# Answers waiting for one connection the code is slow to read. Past this the connection
# is closed: it is the code's own, and nothing else waits on it.
WAITING = 256
# How many bytes of one connection either side sends before it is told to go on: the
# same number as the sandbox service's (wire.ts, WINDOW).
WINDOW = 512 * 1024


class Net:
    """Connections the code makes, passed out as pieces and answered in pieces."""

    def __init__(self, wire):
        self.wire = wire
        self.lock = threading.Lock()
        self.open = {}
        self.back = {}
        # For each connection: how many more of the code's bytes may be passed out.
        self.room = {}
        self.more = threading.Condition(self.lock)
        self.last = 0
        self.port = 0

    def listen(self):
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(("127.0.0.1", PROXY_PORT))
        server.listen(64)
        self.port = server.getsockname()[1]
        threading.Thread(target=self.accept, args=(server,), daemon=True).start()

    def accept(self, server):
        while True:
            try:
                conn, _ = server.accept()
            except OSError:
                return
            answers = queue.Queue(WAITING)
            with self.lock:
                self.last += 1
                number = self.last
                self.open[number] = conn
                self.back[number] = answers
                self.room[number] = WINDOW
            self.wire.send(b"C", number)
            threading.Thread(target=self.out, args=(number, conn), daemon=True).start()
            threading.Thread(target=self.into, args=(number, conn, answers), daemon=True).start()

    def into(self, number, conn, answers):
        """Hands one connection its answers. Its own: a connection nobody reads holds up no other."""
        taken = 0
        while True:
            data = answers.get()
            if data is None:
                # Over, and everything before it has been handed on: now it is closed.
                try:
                    conn.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                try:
                    conn.close()
                except OSError:
                    pass
                return
            try:
                conn.sendall(data)
            except OSError:
                self.close(number, tell=True)
                return
            # The code has taken them: that many more may be sent for it. Said when a
            # fair part of the window is free again, or nothing more is waiting.
            taken += len(data)
            if taken >= WINDOW // 4 or answers.empty():
                self.wire.send(b"W", number, struct.pack(">I", taken))
                taken = 0

    def out(self, number, conn):
        try:
            while True:
                # No more is read from the code than the other side has room for: a
                # host that takes slowly makes the code's own writes wait.
                with self.more:
                    while self.room.get(number, 0) <= 0:
                        if number not in self.open:
                            return
                        self.more.wait(1.0)
                    most = min(PIECE, self.room[number])
                data = conn.recv(most)
                if not data:
                    break
                with self.more:
                    if number in self.room:
                        self.room[number] -= len(data)
                self.wire.send(b"D", number, data)
        except OSError:
            pass
        self.close(number, tell=True)

    def close(self, number, tell):
        with self.more:
            conn = self.open.pop(number, None)
            answers = self.back.pop(number, None)
            self.room.pop(number, None)
            self.more.notify_all()
        if conn is None:
            return
        if answers is not None:
            # Ended from outside: what was answered before the end is still handed on, and
            # its sender closes it after. Ended here (it broke, or the code reads too
            # slowly): what waits is dropped to make room for the word that ends it.
            while True:
                try:
                    answers.put_nowait(None)
                    break
                except queue.Full:
                    try:
                        answers.get_nowait()
                    except queue.Empty:
                        pass
        if tell:
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        if tell:
            self.wire.send(b"X", number)

    def answers(self, stream):
        """What comes back for the connections, until nothing more is handed in."""
        while True:
            got = piece(stream)
            if got is None:
                return
            kind, number, data = got
            if kind == b"D":
                with self.lock:
                    answers = self.back.get(number)
                if answers is not None:
                    # Never waited on here: this one reader serves every connection.
                    try:
                        answers.put_nowait(data)
                    except queue.Full:
                        self.close(number, tell=True)
            elif kind == b"W":
                # So many more of this connection's bytes may be passed out.
                if len(data) == 4:
                    with self.more:
                        if number in self.room:
                            self.room[number] = min(WINDOW, self.room[number] + struct.unpack(">I", data)[0])
                            self.more.notify_all()
            elif kind == b"X":
                self.close(number, tell=False)


def take_in(stream):
    def read(count):
        data = stream.read(count)
        if len(data) != count:
            raise SystemExit("the files handed in stop short")
        return data

    if read(4) != MAGIC:
        raise SystemExit("what was handed in is not a stream of files")
    while True:
        (named,) = struct.unpack(">H", read(2))
        if named == 0:
            return
        name = read(named).decode()
        (size,) = struct.unpack(">I", read(4))
        path = os.path.join(WORK, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as file:
            left = size
            while left:
                part = read(min(left, 1 << 20))
                file.write(part)
                left -= len(part)


def plain(name):
    """Whether a name can go back out: text, no way up, nothing a reader would refuse."""
    try:
        raw = name.encode("utf-8")
    except UnicodeEncodeError:
        return False
    if len(raw) > NAME_BYTES or any(ord(ch) < 32 or ord(ch) == 127 or ch == "\\" for ch in name):
        return False
    return all(part not in ("", ".", "..") and len(part.encode()) <= PART_BYTES for part in name.split("/"))


def walk():
    found = {}
    for folder, names, files in os.walk(WORK):
        names[:] = [n for n in names if os.path.join(folder, n) != RUN and n != "__pycache__"]
        for name in files:
            path = os.path.join(folder, name)
            try:
                if os.path.islink(path) or not os.path.isfile(path):
                    continue
                stat = os.stat(path)
            except OSError:
                continue
            found[os.path.relpath(path, WORK)] = (stat.st_size, stat.st_mtime_ns)
    return found


def said(path):
    """The beginning and the end of what was printed: the middle of a flood says least."""
    size = os.path.getsize(path)
    with open(path, "rb") as file:
        if size <= SAID_BYTES:
            return file.read(), 0
        head = file.read(SAID_BYTES // 2)
        file.seek(size - SAID_BYTES // 2)
        return head + b"\n...\n" + file.read(), size - SAID_BYTES


def main():
    out = os.fdopen(os.dup(1), "wb")
    os.dup2(2, 1)
    sealed()
    wire = Wire(out)
    out.write(WIRE)
    out.flush()
    stdin = sys.stdin.buffer
    if stdin.read(4) != WIRE:
        raise SystemExit("what was handed in is not for a run")
    handed = Handed(stdin)
    take_in(handed)
    handed.finish()
    with open(os.path.join(RUN, "meta.json")) as file:
        meta = json.load(file)
    before = walk()
    home = os.path.join(TMP, "home")
    os.makedirs(home, exist_ok=True)
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": home,
        "TMPDIR": TMP,
        "LANG": "C.UTF-8",
        "PYTHONUNBUFFERED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "MPLCONFIGDIR": os.path.join(home, "mpl"),
        "MATPLOTLIBRC": "/etc/matplotlib/matplotlibrc",
    }
    # The way out, where the run was given one: a proxy on this container's own loopback.
    # The system's folders cannot be written, so what pip installs goes to the person's own.
    if meta.get("net"):
        net = Net(wire)
        try:
            net.listen()
        except OSError:
            net = None
        if net is not None:
            threading.Thread(target=net.answers, args=(stdin,), daemon=True).start()
            proxy = "http://127.0.0.1:%d" % net.port
            for name in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
                env[name] = proxy
            env.update(
                {
                    "NO_PROXY": "localhost,127.0.0.1",
                    "no_proxy": "localhost,127.0.0.1",
                    "PIP_DISABLE_PIP_VERSION_CHECK": "1",
                    "PIP_NO_INPUT": "1",
                    "PIP_USER": "1",
                    "PYTHONUSERBASE": os.path.join(home, ".local"),
                    "PATH": os.path.join(home, ".local", "bin") + ":" + env["PATH"],
                    "npm_config_cache": os.path.join(home, ".npm"),
                    "npm_config_update_notifier": "false",
                }
            )
    command = (
        ["python3", os.path.join(RUN, "main.py")]
        if meta["language"] == "python"
        else ["bash", os.path.join(RUN, "main.sh")]
    )
    started = time.monotonic()
    timed_out = False
    room = [LIVE_BYTES]
    room_lock = threading.Lock()

    def pump(pipe, path, kind):
        """Everything printed is kept; as much as a run may show while it runs is passed on at once."""
        with open(path, "wb") as file:
            while True:
                try:
                    data = os.read(pipe.fileno(), PIECE)
                except OSError:
                    break
                if not data:
                    break
                file.write(data)
                file.flush()
                with room_lock:
                    live = data[: room[0]]
                    room[0] -= len(live)
                if live:
                    wire.send(kind, 0, live)

    child = subprocess.Popen(
        command,
        cwd=WORK,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    pumps = [
        threading.Thread(target=pump, args=(child.stdout, os.path.join(TMP, "stdout"), b"O"), daemon=True),
        threading.Thread(target=pump, args=(child.stderr, os.path.join(TMP, "stderr"), b"E"), daemon=True),
    ]
    for one in pumps:
        one.start()
    try:
        code = child.wait(timeout=meta["timeout"])
    except subprocess.TimeoutExpired:
        timed_out = True
        code = -1
    # Whatever the code started ends with it: nothing is left running to write later.
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    child.wait()
    # Something that slipped out of the code's group may still hold what it prints to: it is not waited for.
    for one in pumps:
        one.join(timeout=3)
    seconds = round(time.monotonic() - started, 2)

    after = walk()
    skipped = []
    changed = []
    total = 0
    held = [b""]

    def write(data):
        held[0] += data
        while len(held[0]) >= PIECE:
            wire.send(b"R", 0, held[0][:PIECE])
            held[0] = held[0][PIECE:]

    def send(name, data):
        raw = name.encode("utf-8")
        write(struct.pack(">H", len(raw)) + raw + struct.pack(">I", len(data)))
        write(data)

    write(MAGIC)
    for name in sorted(after):
        if before.get(name) == after[name]:
            continue
        size = after[name][0]
        if not plain(name) or total + size > OUT_BYTES or len(changed) >= OUT_FILES:
            skipped.append(name.encode("utf-8", "replace").decode()[:200])
            continue
        try:
            path = os.path.join(WORK, name)
            if os.path.islink(path):
                raise OSError("a link")
            with open(path, "rb") as file:
                data = file.read(OUT_BYTES - total + 1)
        except OSError:
            skipped.append(name[:200])
            continue
        if total + len(data) > OUT_BYTES:
            skipped.append(name[:200])
            continue
        send(name, data)
        total += len(data)
        changed.append(name)
    stdout, stdout_cut = said(os.path.join(TMP, "stdout"))
    stderr, stderr_cut = said(os.path.join(TMP, "stderr"))
    send(".result/stdout", stdout)
    send(".result/stderr", stderr)
    send(
        ".result/meta.json",
        json.dumps(
            {
                "exit": code,
                "timedOut": timed_out,
                "seconds": seconds,
                "deleted": sorted(name for name in before if name not in after and plain(name)),
                "skipped": skipped[:200],
                "more": max(0, len(skipped) - 200),
                "cut": stdout_cut + stderr_cut,
            }
        ).encode(),
    )
    write(struct.pack(">H", 0))
    if held[0]:
        wire.send(b"R", 0, held[0])
    wire.send(b"Z")
    out.flush()
    # At once: the threads that pass connections on are not waited for.
    os._exit(0)


if __name__ == "__main__":
    main()
