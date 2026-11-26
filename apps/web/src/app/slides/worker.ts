import { readDeck } from "./parse";

// A presentation is read here, away from the page, so a file that takes long to read
// (or was made to) never stops the app from answering; the page gives up on it after a while.
const port = self as unknown as Worker;
port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  try {
    port.postMessage({ deck: readDeck(new Uint8Array(event.data)) });
  } catch {
    port.postMessage({ deck: null });
  }
};
