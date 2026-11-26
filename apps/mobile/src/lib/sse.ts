/** One Server-Sent Event: its name and its data. */
export interface ServerEvent {
  event: string;
  data: string;
}

/**
 * Reads Server-Sent Events from text that arrives in pieces. Give it each piece as it comes;
 * it returns the events completed so far and keeps the unfinished rest for the next piece.
 */
export function createEventParser(): (chunk: string) => ServerEvent[] {
  let buffer = "";
  let event = "";
  let data: string[] = [];
  return (chunk) => {
    buffer += chunk;
    const events: ServerEvent[] = [];
    for (;;) {
      const end = buffer.search(/\r\n|\n|\r/);
      if (end < 0) break;
      // A lone "\r" at the very end may be the first half of "\r\n": wait for more.
      if (buffer[end] === "\r" && end === buffer.length - 1) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + (buffer.startsWith("\r\n", end) ? 2 : 1));
      if (line === "") {
        if (data.length > 0) events.push({ event: event || "message", data: data.join("\n") });
        event = "";
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    return events;
  };
}
