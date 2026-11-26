/**
 * What kind of thing a command an agent wants to run on a person's computer is (CHA-273).
 * The gateway asks the person, or does not, by this and by the conversation's mode.
 *
 * It reads the command as a shell would cut it up: into the commands joined by `;`, `&&`,
 * `||`, `|`, `&` and line breaks, and each into its words, with quotes taken off. Two
 * questions are answered from that.
 *
 * `onlyLooks`: is every one of them a program known to only show something, used without
 * any option that writes a file or starts another program, on nothing outside the folder?
 * Anything that cannot be read with certainty (an expansion, a redirection, a substitution,
 * an escape) is not.
 *
 * `risk`: does any of them reach outside the attached folder, send something, read where
 * keys are kept, or do what cannot be undone? Then it asks whatever the mode.
 *
 * This is not a sandbox. A command can do what the person can do, and one that hides what
 * it does in a script, an alias or a package's own scripts is not seen through. In the
 * mode that asks, everything that is not plainly looking asks.
 */

/** One command of a line: its words with quotes taken off, and what is known of how the shell would treat it. */
export interface Command {
  words: string[];
  /** A word holds something the shell would put something else in place of: not known until it runs. */
  expands: boolean;
  /** It is fed by the command before it, through a pipe. */
  piped: boolean;
  /** It is put in the background by a lone `&`. */
  background: boolean;
  /** For each word: it holds, outside quotes, something the shell acts on (`$`, `>`, `*`, …). */
  open: boolean[];
  /** A bracket opens in the middle of a word, outside quotes: a function, or a pattern that runs code. */
  globs: boolean;
}
/** What the shell changes when it stands unquoted, and what it changes even inside double quotes. */
const UNQUOTED = /[`$<>(){}*?[\]!#]/;
const IN_DOUBLE = /[`$]/;

/** The commands a line holds. Null when it cannot be read with certainty. */
export function parse(command: string): Command[] | null {
  // A carriage return is an ordinary character to the shell and the end of a line to
  // much else: a line that holds one is not read.
  if (command.includes("\r")) return null;
  const commands: Command[] = [];
  const fresh = (piped: boolean): Command => ({
    words: [],
    expands: false,
    piped,
    background: false,
    open: [],
    globs: false,
  });
  let now = fresh(false);
  let word = "";
  let started = false;
  let wordOpen = false;
  // How the word was written, which its text does not tell: whether the last character
  // is an arrow that stood outside quotes, and whether it is so far nothing but the
  // number of a stream (`2`, or `&`) written outside quotes. A quoted `'x>'` ends in no
  // arrow: taking it for one made `ls 'x>'&git push` one command that only looks.
  let arrow = false;
  let stream = false;
  // The character before was a bracket that closed, outside quotes: one that opens right
  // after it is zsh's pattern that runs code (`(*)(e:'cmd':)`), not a group.
  let closed = false;
  const endWord = () => {
    if (started) {
      now.words.push(word);
      now.open.push(wordOpen);
    }
    word = "";
    started = false;
    wordOpen = false;
    arrow = false;
    stream = false;
  };
  const endCommand = (next: { piped?: boolean; background?: boolean } = {}) => {
    endWord();
    if (next.background) now.background = true;
    if (now.words.length) commands.push(now);
    now = fresh(next.piped === true);
  };
  for (let at = 0; at < command.length; at++) {
    const ch = command[at] as string;
    const afterClosed = closed;
    closed = false;
    if (ch === "'") {
      const close = command.indexOf("'", at + 1);
      if (close < 0) return null;
      word += command.slice(at + 1, close);
      started = true;
      arrow = false;
      stream = false;
      at = close;
    } else if (ch === '"') {
      // Read as the shell reads it: a backslash keeps the next character from ending the
      // quotes or standing for something (`"\""`, `"\$HOME"`); before any other
      // character it is itself (`"\n"` for printf). An everyday `printf "…\n"` was once
      // not read at all, and so asked about in every mode.
      let inside = "";
      let close = -1;
      for (let to = at + 1; to < command.length; to++) {
        const c = command[to] as string;
        if (c === "\\") {
          const next = command[to + 1];
          if (next === undefined) return null;
          inside += '"\\$`'.includes(next) ? next : next === "\n" ? "" : c + next;
          to += 1;
        } else if (c === '"') {
          close = to;
          break;
        } else {
          if (IN_DOUBLE.test(c)) {
            now.expands = true;
            wordOpen = true;
          }
          inside += c;
        }
      }
      if (close < 0) return null;
      word += inside;
      started = true;
      arrow = false;
      stream = false;
      at = close;
    } else if (ch === "\\") {
      // Outside quotes it makes the next character an ordinary one, part of the word
      // (`r\m` is `rm`); at the end of a line it joins the next line to this one.
      const next = command[at + 1];
      if (next === undefined) return null;
      if (next !== "\n") {
        word += next;
        started = true;
        arrow = false;
        stream = false;
      }
      at += 1;
    } else if (ch === "#" && !started) {
      // A comment runs to the end of its line, quotes and backslashes in it included:
      // what follows on the next line is a command of its own.
      const end = command.indexOf("\n", at);
      if (end < 0) break;
      at = end - 1;
    } else if (ch === "<" && command[at + 1] === "<" && command[at + 2] !== "<") {
      // A here-document: its lines are text, not commands, and telling them apart is not
      // done here. Not read.
      return null;
    } else if (ch === "$" && command[at + 1] === "'") {
      // `$'…'` has escapes of its own, which change where it ends. Not read.
      return null;
    } else if (ch === " " || ch === "\t") endWord();
    else if (ch === "\n" || ch === ";") endCommand();
    else if (ch === "|" && arrow) {
      // `>|file`: where the output goes, not a pipe.
      word += ch;
      arrow = false;
    } else if (ch === "|") {
      const or = command[at + 1] === "|";
      if (or) at += 1;
      endCommand({ piped: !or });
    } else if (ch === "&" && arrow) {
      // `2>&1`, `>&2`: part of where the output goes, not the end of a command.
      word += ch;
      arrow = false;
    } else if (ch === "&" && command[at + 1] === ">") {
      // `&>file`: the same, and a word of its own wherever it stands (`git&>x push`).
      endWord();
      word = ch;
      started = true;
      wordOpen = true;
      stream = true;
    } else if (ch === "&") {
      const and = command[at + 1] === "&";
      if (and) at += 1;
      endCommand({ background: !and });
    } else if (ch === ")") {
      // Closes a group or a substitution: no part of a word (`(cat .env)` reads `.env`).
      now.expands = true;
      endWord();
      closed = true;
    } else if (ch === "(" && !started) {
      // Opens a group. `f ()` is a function, which is not read; so is a bracket right
      // after one that closed.
      now.expands = true;
      if (command[at + 1] === ")" || afterClosed) now.globs = true;
    } else {
      if (UNQUOTED.test(ch) || (ch === "~" && !started)) {
        now.expands = true;
        wordOpen = true;
      }
      if (ch === "(" && !/[$<>(]$/.test(word)) now.globs = true;
      const isArrow = ch === "<" || ch === ">";
      // An arrow begins a word of its own, as it does for the shell (`git>x push` runs
      // `git push`), unless what stands before it is the number of a stream (`2>x`) or
      // another arrow (`>>`).
      if (isArrow && started && !stream && !arrow) {
        endWord();
        wordOpen = true;
      }
      stream = !isArrow && /\d/.test(ch) && (!started || stream);
      arrow = isArrow;
      word += ch;
      started = true;
    }
  }
  endCommand();
  return commands;
}

/** A program as it is called, without where it is and without what only wraps it. */
function program(words: string[]): { at: number; called: string; name: string; args: string[] } {
  let at = 0;
  // `A=b cmd`, `command cmd`, `env A=b cmd`, `time cmd`, `nohup cmd`, `exec cmd`; and the
  // shell's own words before what a loop or a condition runs (`do git push`, `then rm …`,
  // `! cmd`, `{ cmd`): the program is what comes after them. Without this a loop's body
  // was judged as a program called "do", which is no program and so never asked about.
  while (
    at < words.length - 1 &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at] as string) ||
      [
        "command",
        "env",
        "time",
        "nohup",
        "exec",
        "builtin",
        "do",
        "then",
        "else",
        "elif",
        "if",
        "while",
        "until",
        "!",
        "{",
        "(",
        "noglob",
        "nocorrect",
        "coproc",
      ].includes(words[at] as string))
  )
    at += 1;
  // `(cmd` and `$(cmd`: what is run in brackets is still that program.
  const called = (words[at] ?? "").replace(/^(\$?\(|`)+/, "");
  return {
    at,
    called,
    name: called.slice(called.lastIndexOf("/") + 1).replace(/[)`]+$/, ""),
    // The bracket that closes them is not part of the last word.
    args: words.slice(at + 1).map((arg) => arg.replace(/[)`]+$/, "")),
  };
}

/** Names that hold keys and passwords, as the desktop app's own list has them (apps/desktop/src/local.ts). */
const SECRET_NAMES = [
  /^\.env(\.(?!example$|sample$|template$).*)?$/i,
  /^\.ssh$/i,
  /^\.aws$/i,
  /^\.gnupg$/i,
  /^\.kube$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|kdbx|ovpn)$/i,
  /^\.netrc$/i,
  /^credentials(\.json)?$/i,
  /^\.(npmrc|pypirc|git-credentials)$/i,
  /^\.(docker|config)$/i,
  /_history$/i,
  /^keychains?$/i,
  /^hosts\.yml$/i,
];
/** The parts of a word that could each be a name: cut at `/`, `:` and `=`. */
const names = (word: string) => word.split(/[/:=]/).filter(Boolean);
const holdsSecrets = (word: string) =>
  names(word).some((name) => SECRET_NAMES.some((rule) => rule.test(name)));
/** A word that points outside the folder the command runs in: the disk, the home folder, a way up. */
const outside = (word: string) => {
  // An address is not a place on this computer.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(word))
    return /\$\{?(HOME|PWD|OLDPWD|TMPDIR|USER)\b/.test(word);
  // After an option's `=`, and after a `:` as in `HEAD:path`, comes a place too.
  const places = [word, ...word.split(/[=:]/).slice(1)];
  return places.some(
    (place) =>
      (place.startsWith("/") && !/^\/dev\/(null|stdin|stdout|stderr|tty|fd\/\d+)$/.test(place)) ||
      place.startsWith("~") ||
      /(^|\/)\.\.(\/|$)/.test(place) ||
      /\$\{?(HOME|PWD|OLDPWD|TMPDIR|USER)\b/.test(place),
  );
};
/** What of git only shows something: the first word after `git`, with no option before it. */
const GIT_LOOKS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "blame",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "describe",
  "shortlog",
]);
/**
 * Whether any option given is one of these long options, written out or cut short: the
 * GNU tools take any beginning of a long option that could be no other, so `--out` is
 * `--output`. An option that could be a blocked one is treated as that one.
 */
const long = (args: string[], blocked: string[]) =>
  args.some((arg) => {
    if (!arg.startsWith("--") || arg === "--") return false;
    const name = arg.split("=")[0] as string;
    return blocked.some((one) => one.startsWith(name) || name.startsWith(one));
  });
/** Programs whose version can be asked without asking the person: what a developer's computer has by these names. */
const VERSIONED = new Set([
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "tsc",
  "python",
  "python3",
  "pip",
  "pip3",
  "uv",
  "poetry",
  "ruff",
  "git",
  "go",
  "cargo",
  "rustc",
  "java",
  "javac",
  "mvn",
  "gradle",
  "ruby",
  "gem",
  "php",
  "composer",
  "make",
  "cmake",
  "gcc",
  "clang",
  "docker",
  "dotnet",
  "swift",
]);
/** Programs that only show something, each with the options that would make it write or run. */
const LOOKS: Record<string, (args: string[]) => boolean> = {
  ls: () => true,
  cat: () => true,
  head: () => true,
  tail: (args) =>
    !args.some((arg) => /^-[a-zA-Z]*[fF]/.test(arg)) && !long(args, ["--follow", "--retry"]),
  wc: (args) => !long(args, ["--files0-from"]),
  pwd: () => true,
  echo: () => true,
  which: () => true,
  basename: () => true,
  dirname: () => true,
  date: (args) => !args.some((arg) => /^-[a-zA-Z]*s/.test(arg)) && !long(args, ["--set", "--file"]),
  whoami: () => true,
  uname: () => true,
  true: () => true,
  stat: () => true,
  // `-C` writes a compiled database beside the one it is given.
  file: (args) =>
    !args.some((arg) => /^-[a-zA-Z]*[Cm]/.test(arg)) &&
    !long(args, ["--compile", "--magic-file", "--files-from"]),
  du: (args) => !long(args, ["--files0-from"]),
  df: () => true,
  nl: () => true,
  cut: () => true,
  cmp: () => true,
  diff: (args) => !long(args, ["--output", "--to-file", "--from-file"]),
  grep: (args) => !args.some((arg) => /^-[a-zA-Z]*f/.test(arg)) && !long(args, ["--file"]),
  rg: (args) =>
    !args.some((arg) => /^-[a-zA-Z]*[zf]/.test(arg)) &&
    !long(args, ["--pre", "--hostname-bin", "--search-zip", "--file", "--ignore-file"]),
  // It takes its short flags together ("-ao notes.md"), and -R with -H writes a page into
  // every folder: any group of them with an o or an R in it is refused.
  tree: (args) =>
    !args.some((arg) => /^-[a-zA-Z]*[oR]/.test(arg)) && !long(args, ["--fromfile", "--output"]),
  sort: (args) =>
    !args.some((arg) => /^-[a-zA-Z]*[oT]/.test(arg)) &&
    !long(args, [
      "--output",
      "--temporary-directory",
      "--compress-program",
      "--files0-from",
      "--random-source",
    ]),
  // One file at most: a second is where it writes.
  uniq: (args) => args.filter((arg) => !arg.startsWith("-")).length <= 1,
  find: (args) => !args.some((arg) => /^-(delete|exec|execdir|ok|okdir|fls|fprint)/.test(arg)),
  // A filter that reads the environment or another file is not plain looking.
  jq: (args) =>
    !args.some((arg) => /env|input|import|include|^-[a-zA-Z]*[fL]/.test(arg)) &&
    !long(args, ["--rawfile", "--slurpfile", "--args", "--jsonargs", "--from-file"]),
  git: (args) =>
    // Listing branches, and nothing else of `branch`.
    (args[0] === "branch"
      ? args.slice(1).every((arg) => /^(-a|-r|-v|-vv|--list|--show-current)$/.test(arg))
      : GIT_LOOKS.has(args[0] ?? "")) &&
    !args.some((arg) => /^-[cC]$/.test(arg)) &&
    !long(args, [
      "--output",
      "--ext-diff",
      "--textconv",
      "--no-index",
      "--exec",
      "--git-dir",
      "--work-tree",
      "--contents",
    ]),
};

/** Whether every part of a command plainly only looks: nothing written, started or sent, nothing outside the folder. */
export function onlyLooks(command: string): boolean {
  const commands = parse(command);
  if (!commands || commands.length === 0) return false;
  return commands.every(({ words, expands, background }) => {
    if (expands || background) return false;
    // A place outside the folder, or a name that holds secrets.
    if (words.some((word) => outside(word) || holdsSecrets(word))) return false;
    // Nothing before the program, and the program by its plain name.
    const [name = "", ...args] = words;
    if (name.includes("/") || name.includes("=")) return false;
    if (args.length === 1 && /^(--version|-V)$/.test(args[0] as string) && VERSIONED.has(name))
      return true;
    return Object.hasOwn(LOOKS, name) ? (LOOKS[name]?.(args) ?? false) : false;
  });
}

const WHY = {
  admin: "It asks for an administrator's rights.",
  outside: "It reaches outside the folder it runs in.",
  secrets: "It reads where keys and passwords are kept.",
  deletes: "It deletes or overwrites more than can be brought back.",
  shared: "It sends work to a shared repository, or discards or rewrites work in this one.",
  publishes: "It publishes something, or acts on a shared service in your name.",
  remote: "It can change what runs outside this computer.",
  other: "It reaches another computer.",
  sends: "It sends something to an address outside.",
  hidden: "It runs something fetched or hidden, which cannot be read here first.",
  rights: "It changes who may do what on this computer, or what runs by itself.",
  stops: "It stops this computer or what runs on it.",
  apps: "It acts outside the terminal, in other apps on this computer.",
};
const CLOUD = new Set([
  "kubectl",
  "helm",
  "terraform",
  "pulumi",
  "ansible-playbook",
  "aws",
  "gcloud",
  "az",
  "vercel",
  "netlify",
  "fly",
  "flyctl",
  "heroku",
  "wrangler",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "ksh", "dash", "fish"]);
/** What of `gh` only shows something. Everything else acts in the person's name. */
const GH_LOOKS =
  /^(pr (view|list|status|diff|checks)|issue (view|list|status)|run (view|list|watch)|repo view|auth status|status|search )/;

/** The first word of a git command that is not an option: what it is asked to do, and what follows. */
function gitAsked(args: string[]): { verb: string; rest: string[] } {
  let at = 0;
  while (at < args.length && (args[at] as string).startsWith("-")) {
    // `-c name=value` and `-C dir` take the next word.
    at += (args[at] === "-c" || args[at] === "-C") && at + 1 < args.length ? 2 : 1;
  }
  return { verb: args[at] ?? "", rest: args.slice(at + 1) };
}

/** Where the system keeps its own programs: calling one by its whole path reaches nowhere. */
const SYSTEM_BIN = /^\/(usr\/(local\/)?)?s?bin\/[^/]+$|^\/opt\/homebrew\/s?bin\/[^/]+$/;
/** Programs that run the command they are given. What they run is judged as itself. */
const RUNS_ANOTHER = new Set([
  "xargs",
  "nice",
  "ionice",
  "timeout",
  "gtimeout",
  "stdbuf",
  "watch",
  "coproc",
  "setsid",
  "caffeinate",
  "env",
  "time",
  "nohup",
  "exec",
  "command",
  "builtin",
  "parallel",
  "flock",
  "chronic",
  "unbuffer",
  "script",
  "npx",
  "bunx",
  "pnpx",
  "noglob",
  "nocorrect",
]);

/** What may still be looked at before a command is asked about for being too much to judge. */
interface Budget {
  left: number;
}
/** Variables that change which program runs, or have one run by itself. */
const STEERS =
  /^(PATH|ENV|BASH_ENV|BASH_FUNC_.*|ZDOTDIR|HOME|XDG_[A-Z_]+|PROMPT_COMMAND|SHELLOPTS|LD_[A-Z_]+|DYLD_[A-Z_]+|GIT_[A-Z_]*(SSH|COMMAND|EDITOR|PAGER|EXTERNAL|ASKPASS|PROXY|EXEC|CONFIG|TEMPLATE|HOOK|DIR|TREE)[A-Z_]*|EDITOR|VISUAL|PAGER|BROWSER|NODE_OPTIONS|NODE_PATH|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|NPM_CONFIG_[A-Z_]+|PIP_[A-Z_]*(INDEX|CONFIG)[A-Z_]*|DOCKER_(HOST|CONFIG|CONTEXT)|KUBECONFIG|SSH_AUTH_SOCK|SSH_ASKPASS)$/i;
/** Where git keeps what it runs by itself. */
const HOOKS = /(^|\/)(\.git\/hooks|\.husky)(\/|$)/;
/** A place inside the repository's own record. */
const IN_GIT = /(^|\/)\.git(\/|$)/;
/** A place as it is, however it was written (`.git//hooks`, `./.git/./hooks`). */
const tidy = (place: string) => place.replace(/\/(\.?\/)+/g, "/").replace(/^(\.\/)+/, "");

/**
 * A command's words without where its input comes from and its output goes (`> out`,
 * `2>&1`, `< in`): those are no part of what is run, wherever they stand, and the places
 * they name are judged as places.
 */
function unredirected(
  words: string[],
  open: boolean[],
): { words: string[]; open: boolean[]; targets: string[]; input: boolean } {
  const out: string[] = [];
  const kept: boolean[] = [];
  const targets: string[] = [];
  let input = false;
  for (let at = 0; at < words.length; at++) {
    const word = words[at] as string;
    const found = open[at] ? /^(?:\d*|&)(>>?\|?|<>?)&?(.*)$/.exec(word) : null;
    if (!found) {
      out.push(word);
      kept.push(open[at] === true);
      continue;
    }
    if ((found[1] as string).startsWith("<")) input = true;
    let target = found[2] as string;
    // `>&-` closes a stream, and bash takes what is written against it for the next
    // word (`git >&-push` runs `git push`).
    if (/&-./.test(word) && target.startsWith("-")) {
      out.push(target.slice(1));
      kept.push(false);
      continue;
    }
    if (target === "" && at + 1 < words.length) {
      at += 1;
      target = words[at] as string;
    }
    // A number or `-` is another of the command's own streams, not a place.
    if (target && !/^(\d+|-)$/.test(target)) targets.push(target);
  }
  return { words: out, open: kept, targets, input };
}

function riskOf(
  given: string[],
  givenOpen: boolean[],
  piped: string | null,
  depth: number,
  budget: Budget,
): string | null {
  // What is looked at is paid for by its size: a call on many words is many steps.
  budget.left -= 1 + given.length;
  if (budget.left < 0) return WHY.hidden;
  const { words, open, targets, input } = unredirected(given, givenOpen);
  if (targets.some(holdsSecrets)) return WHY.secrets;
  if (targets.some(outside)) return WHY.outside;
  const { at: where, called, name, args } = program(words);
  const raw = words[where] ?? "";
  // A program whose name the shell works out when it runs (`$g push`, `g?t push`,
  // `{git,push}`, `"$(echo git)" push`, zsh's `=git`) is not known here.
  if (
    raw.startsWith("=") ||
    (open[where] === true &&
      !["[", "[[", "{", "}", "]]", "]"].includes(raw) &&
      /[`$*?[\]{}~]/.test(raw))
  )
    return outside(raw) ? WHY.outside : WHY.hidden;
  // What is set for the one command: a variable that decides which program runs or has
  // one run by itself, or one that points outside.
  // Also when it is set to stay (`export PATH=…`, `PATH=…` alone on a line).
  const sets = ["export", "declare", "typeset", "readonly", "local", "setenv"].includes(name);
  for (let at = 0; at < words.length; at++) {
    if (at > where && !sets) break;
    const set = /^([A-Za-z_][A-Za-z0-9_%]*)=(.*)$/.exec(words[at] as string);
    if (!set) continue;
    if (STEERS.test(set[1] as string)) return WHY.hidden;
    if (outside(set[2] as string)) return WHY.outside;
  }
  // A program outside the folder, by its path: a script in /tmp, one above the folder.
  if (called.includes("/") && outside(called) && !SYSTEM_BIN.test(called)) return WHY.outside;
  // What git runs by itself at the next commit, and what zsh evaluates inside `${(e)…}`.
  if ([...words, ...targets].some((word) => HOOKS.test(tidy(word)))) return WHY.rights;
  // What is written into the repository's own record changes what git does next.
  if (targets.some((word) => IN_GIT.test(tidy(word)))) return WHY.shared;
  if (words.some((word) => word.includes("${("))) return WHY.hidden;
  const runsAnother =
    name.startsWith("-") ||
    RUNS_ANOTHER.has(name) ||
    (["npm", "pnpm", "yarn", "bun"].includes(name) &&
      args.some((arg) => ["exec", "dlx", "x"].includes(arg)));
  const execs = name === "find" && args.some((arg) => /^-(exec|execdir|ok|okdir)$/.test(arg));
  // Too deep to follow, or too many words to try each as the start of a command: asked about.
  if ((runsAnother || execs) && (depth >= 4 || args.length > 200)) return WHY.hidden;
  if (name === "find") {
    if (args.includes("-delete")) return WHY.deletes;
    // `find … -exec git push {} \;` runs git push, once for each file.
    for (let at = 0; at < args.length; at++) {
      if (!/^-(exec|execdir|ok|okdir)$/.test(args[at] as string)) continue;
      let end = at + 1;
      while (end < args.length && args[end] !== ";" && args[end] !== "+") end += 1;
      const why = riskOf(
        words.slice(where + 2 + at, where + 1 + end),
        open.slice(where + 2 + at, where + 1 + end),
        null,
        depth + 1,
        budget,
      );
      if (why) return why;
      at = end;
    }
  }
  // What stands before the program was an option, not a wrapper the shell knows
  // (`env -i git push`, where `env` was passed over), or the program is one that runs
  // another (`xargs git push`, `timeout 5 git push`, `npx vercel`). Which word begins the
  // command it runs depends on each program's options, so every word that could is
  // tried: asking once too often is the lesser mistake.
  if (runsAnother) {
    for (let at = 0; at < args.length && at < 48; at++) {
      const word = args[at] as string;
      // An option, or the place where `xargs -I{}` puts each name: no program.
      if (word.startsWith("-") || word === "{}" || word === "." || word === "..") continue;
      // `env -S "git push"`, `watch "git push"`: a command given as one word.
      const why = /\s/.test(word)
        ? judge(word, depth + 1, budget)
        : riskOf(words.slice(where + 1 + at), open.slice(where + 1 + at), null, depth + 1, budget);
      if (why) return why;
    }
  }
  const has = (test: RegExp) => args.some((arg) => test.test(arg));
  const operands = args.filter((arg) => !arg.startsWith("-"));
  if (["sudo", "doas", "su"].includes(name)) return WHY.admin;
  // What it is given to work on, wherever it stands in the command.
  if (
    words.some(holdsSecrets) ||
    has(/\$\{?[A-Za-z_]*(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE)/i)
  )
    return WHY.secrets;
  if (
    (name === "env" && args.length === 0) ||
    name === "printenv" ||
    (name === "security" && has(/^find-/))
  )
    return WHY.secrets;
  if (args.some(outside)) return WHY.outside;
  // `cd` alone, and `cd -`, go to the home folder or wherever was before.
  // `popd` goes back to where a `pushd` came from: not asked about.
  if (["cd", "pushd"].includes(name) && (operands.length === 0 || operands[0] === "-"))
    return WHY.outside;
  if (name === "rm" || name === "rmdir" || name === "unlink") {
    const deep = has(/^-[a-zA-Z]*[rR]/) || has(/^--recursive$/);
    if (
      operands.map(tidy).some(
        (target) =>
          IN_GIT.test(target) ||
          /(^|\/)\*+$/.test(target) ||
          // Nothing but patterns and dots: everything there is.
          (/[*?]/.test(target) && /^[*?./]+$/.test(target)) ||
          // With all that is under it, and named by a pattern: not known what it names.
          (deep && /[*?[\]{}`]/.test(target)) ||
          target === "." ||
          target === "" ||
          /\$/.test(target),
      )
    )
      return WHY.deletes;
  }
  // The repository's own record moved, cut short or written over.
  if (
    ["mv", "cp", "truncate", "tee", "dd", "ln", "install", "rsync", "sed", "chmod"].includes(
      name,
    ) &&
    args.some((arg) => IN_GIT.test(tidy(arg.replace(/^[a-z]+=/, ""))))
  )
    return WHY.shared;
  if (["mkfs", "shred", "diskutil", "fdisk"].includes(name) || (name === "dd" && has(/^of=/)))
    return WHY.deletes;
  if (name === "git") {
    const { verb, rest } = gitAsked(args);
    const flag = (test: RegExp) => rest.some((arg) => test.test(arg));
    // A setting given for the one command, or written to stay, can name a program to run
    // (`-c alias.x='!cmd'`, `core.sshCommand`, `core.hooksPath`).
    if (
      args.slice(0, args.indexOf(verb) < 0 ? args.length : args.indexOf(verb)).includes("-c") ||
      has(/^--config-env/) ||
      (verb === "submodule" && rest.includes("foreach")) ||
      (verb === "bisect" && rest[0] === "run") ||
      (verb === "difftool" && flag(/^(-x|--extcmd)/))
    )
      return WHY.hidden;
    if (
      verb === "config" &&
      !flag(/^(--get(-all|-regexp|-urlmatch)?|--list|-l|--show-origin|--show-scope)$/) &&
      rest.filter((arg) => !arg.startsWith("-")).length > 1
    )
      return WHY.hidden;
    if (
      verb === "push" ||
      (verb === "reset" && flag(/^--hard$/)) ||
      (verb === "clean" && flag(/^-[a-zA-Z]*f/)) ||
      ((verb === "checkout" || verb === "restore") &&
        rest.some((arg) => arg === "." || arg === "--")) ||
      (verb === "branch" && flag(/^-D$|^--delete$|^-d$/)) ||
      verb === "rebase" ||
      verb === "filter-branch" ||
      verb === "filter-repo" ||
      (verb === "update-ref" && flag(/^-d$/)) ||
      (verb === "stash" && ["drop", "clear"].includes(rest[0] ?? "")) ||
      (verb === "commit" && flag(/^--amend$/)) ||
      (verb === "tag" && flag(/^-d$|^--delete$/)) ||
      (verb === "remote" && ["add", "set-url", "remove", "rm"].includes(rest[0] ?? ""))
    )
      return WHY.shared;
  }
  if (
    (["npm", "pnpm", "yarn", "bun"].includes(name) && operands.includes("publish")) ||
    (name === "cargo" && operands[0] === "publish") ||
    (name === "twine" && operands[0] === "upload") ||
    (name === "gem" && operands[0] === "push") ||
    (name === "docker" && ["push", "login"].includes(operands[0] ?? "")) ||
    (name === "gh" && !GH_LOOKS.test(`${operands.slice(0, 2).join(" ")} `))
  )
    return WHY.publishes;
  if (CLOUD.has(name)) return WHY.remote;
  if (["ssh", "scp", "sftp", "telnet", "nc", "ncat"].includes(name)) return WHY.other;
  if (name === "rsync" && operands.some((arg) => /^[^/]+:/.test(arg))) return WHY.other;
  if (
    ["curl", "wget", "http", "https", "xh"].includes(name) &&
    (has(/^(-d|--data|-F|--form|-T|--upload-file|--post-data|--post-file|--body-data|--json)/) ||
      args.some(
        (arg, at) =>
          /^(-X|--request|--method)$/.test(arg) &&
          /^(POST|PUT|PATCH|DELETE)$/i.test(args[at + 1] ?? ""),
      ) ||
      has(/^(-X|--request=|--method=)(POST|PUT|PATCH|DELETE)$/i) ||
      // What is put into the address goes out with it.
      has(/\$/))
  )
    return WHY.sends;
  if (["eval", "trap", "alias"].includes(name)) return WHY.hidden;
  // Reading a file in as commands. A lone `.` is a place (`eslint .`), not this.
  if ((name === "source" || name === ".") && operands.length > 0) return WHY.hidden;
  // A shell that is told what to run (`-c`, also among other letters: `-lc`), or reads it
  // from somewhere, rather than a file by name.
  if (
    SHELLS.has(name) &&
    (piped !== null || input || has(/^-[a-zA-Z]*c[a-zA-Z]*$/) || operands.length === 0)
  )
    return WHY.hidden;
  if (
    (name === "chmod" && (has(/^-R$/) || has(/^[0-7]*7[0-7]{2}$/) || has(/\+s/))) ||
    (name === "chown" && has(/^-R$/)) ||
    ["crontab", "launchctl", "systemctl", "defaults", "csrutil", "spctl"].includes(name)
  )
    return WHY.rights;
  if (["shutdown", "reboot", "halt", "killall", "pkill"].includes(name)) return WHY.stops;
  if (name === "kill" && has(/^-1$/)) return WHY.stops;
  if (["osascript", "open", "xdg-open", "automator", "shortcuts"].includes(name)) return WHY.apps;
  return null;
}

/** A line longer than this is not judged piece by piece: it is asked about. */
const MAX_JUDGED = 20_000;
/** How deep brackets and quotes may be nested in one another before the line is not read. */
const MAX_NESTED = 60;

/** Where the double quotes opened before `from` close. -1 when they do not. */
function closingQuote(command: string, from: number, nested: number): number {
  if (nested > MAX_NESTED) return -1;
  for (let at = from; at < command.length; at++) {
    const ch = command[at];
    if (ch === "\\") at += 1;
    else if (ch === '"') return at;
    else if (ch === "$" && command[at + 1] === "(") {
      const close = closingBracket(command, at + 2, nested + 1);
      if (close < 0) return -1;
      at = close;
    }
  }
  return -1;
}

/** Where the bracket opened before `from` closes, quotes inside it read as the shell reads them. -1 when it does not. */
function closingBracket(command: string, from: number, nested: number): number {
  if (nested > MAX_NESTED) return -1;
  let depth = 1;
  for (let at = from; at < command.length; at++) {
    const ch = command[at];
    if (ch === "\\") at += 1;
    else if (ch === "'") {
      const close = command.indexOf("'", at + 1);
      if (close < 0) return -1;
      at = close;
    } else if (ch === '"') {
      const close = closingQuote(command, at + 1, nested + 1);
      if (close < 0) return -1;
      at = close;
    } else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
}

/**
 * A line without its comments and without the text of its here-documents, which are not
 * commands. One place decides what a comment is, as the shell does: a `#` where no word
 * has begun, outside quotes. It follows quotes and brackets into one another as the
 * shell does (`"$(echo " #"; cmd)"` holds no comment), since a reader that did not took
 * a quote inside a substitution for the end of the quotes around it and cut real
 * commands away as a comment. A here-document is read only when its end word is quoted
 * and stands alone (`<<'EOF'`), so that nothing in its text is run or replaced; it is
 * left in the line as input from a file called HEREDOC. Null when the line cannot be
 * read with certainty.
 */
function plain(command: string): string | null {
  return plainCode(command, 0, false, 0)?.text ?? null;
}

/** Where reading goes on from `at`, past any lines joined there by a backslash. */
function joined(command: string, at: number): number {
  let to = at;
  while (command[to] === "\\" && command[to + 1] === "\n") to += 2;
  return to;
}

/**
 * Where `${NAME}` closes, given where its `{` stands: a plain name and nothing more.
 * `${x:-…}`, `${x%% #*}`, `${(e)x}` and the like hold text with rules of their own (a `#`
 * that is no comment, quotes inside quotes, zsh's flags that run code): not read. -1.
 */
function simpleName(command: string, brace: number): number {
  const close = command.indexOf("}", brace + 1);
  if (close < 0) return -1;
  return /^([A-Za-z_][A-Za-z0-9_]*|[0-9@*?$!-])$/.test(command.slice(brace + 1, close))
    ? close
    : -1;
}

/** Code from `from`, to the bracket that closes it when `closes`, else to the end. */
function plainCode(
  command: string,
  from: number,
  closes: boolean,
  nested: number,
): { text: string; at: number } | null {
  if (nested > MAX_NESTED) return null;
  let out = "";
  let pending: { end: string; tabs: boolean }[] = [];
  let started = false;
  for (let at = from; at < command.length; at++) {
    const ch = command[at] as string;
    if (ch === "\\") {
      const next = command[at + 1];
      if (next === undefined) return null;
      // A backslash at the end of a line joins the next line to this one, before anything
      // else is read: both are gone (`$\` and `(cmd)` on the next line is `$(cmd)`).
      if (next !== "\n") {
        out += ch + next;
        started = true;
      }
      at += 1;
    } else if (ch === "'") {
      const close = command.indexOf("'", at + 1);
      if (close < 0) return null;
      out += command.slice(at, close + 1);
      at = close;
      started = true;
    } else if (ch === '"') {
      const inner = plainQuoted(command, at + 1, nested + 1);
      if (!inner) return null;
      out += `"${inner.text}"`;
      at = inner.at;
      started = true;
    } else if (ch === "`") {
      // The older way to write `$(…)`, with rules of its own for backslashes. Not read.
      return null;
    } else if (ch === "$" && command[joined(command, at + 1)] === "{") {
      const close = simpleName(command, joined(command, at + 1));
      if (close < 0) return null;
      out += command.slice(at, close + 1);
      at = close;
      started = true;
    } else if (ch === "#" && !started) {
      const end = command.indexOf("\n", at);
      if (end < 0) {
        // To the end of the line, the bracket that would close this included.
        if (closes) return null;
        break;
      }
      at = end - 1;
    } else if (ch === "\n") {
      out += ch;
      started = false;
      // The text of the here-documents begun on this line, each up to its end word.
      for (const doc of pending) {
        let ended = false;
        while (!ended && at < command.length) {
          const end = command.indexOf("\n", at + 1);
          const line = command.slice(at + 1, end < 0 ? command.length : end);
          at = end < 0 ? command.length : end;
          ended = (doc.tabs ? line.replace(/^\t+/, "") : line) === doc.end;
        }
        if (!ended) return null;
      }
      pending = [];
      // The end word's own line break is gone with it: the next line begins here.
    } else if (command.startsWith("<<<", at)) {
      out += "<<<";
      at += 2;
      started = true;
    } else if (command.startsWith("<<", at)) {
      let to = at + 2;
      const tabs = command[to] === "-";
      if (tabs) to += 1;
      while (command[to] === " " || command[to] === "\t") to += 1;
      const quote = command[to];
      // An end word without quotes: the text is replaced in and may run something.
      if (quote !== "'" && quote !== '"') return null;
      const close = command.indexOf(quote, to + 1);
      if (close < 0) return null;
      const end = command.slice(to + 1, close);
      if (!/^[A-Za-z0-9_.-]+$/.test(end)) return null;
      // Anything written against the quotes is part of the end word for the shell.
      const after = command[close + 1];
      if (after !== undefined && !" \t\n;|&<>)".includes(after)) return null;
      pending.push({ end, tabs });
      out += " <HEREDOC ";
      at = close;
      started = false;
    } else if (ch === "(") {
      const inner = plainCode(command, at + 1, true, nested + 1);
      if (!inner) return null;
      out += `(${inner.text})`;
      at = inner.at;
      started = true;
    } else if (ch === ")" && closes) {
      // A here-document whose text never came.
      if (pending.length > 0) return null;
      return { text: out, at };
    } else {
      started = !(ch === " " || ch === "\t" || ch === ";" || ch === "&" || ch === "|");
      out += ch;
    }
  }
  if (closes || pending.length > 0) return null;
  return { text: out, at: command.length };
}

/** What stands in double quotes from `from`, to the quote that closes them. */
function plainQuoted(
  command: string,
  from: number,
  nested: number,
): { text: string; at: number } | null {
  if (nested > MAX_NESTED) return null;
  let out = "";
  for (let at = from; at < command.length; at++) {
    const ch = command[at] as string;
    if (ch === "\\") {
      const next = command[at + 1];
      if (next === undefined) return null;
      // Joined lines, as outside quotes.
      if (next !== "\n") out += ch + next;
      at += 1;
    } else if (ch === '"') return { text: out, at };
    else if (ch === "`") return null;
    else if (ch === "$" && command[joined(command, at + 1)] === "(") {
      const inner = plainCode(command, joined(command, at + 1) + 1, true, nested + 1);
      if (!inner) return null;
      out += `$(${inner.text})`;
      at = inner.at;
    } else if (ch === "$" && command[joined(command, at + 1)] === "{") {
      const close = simpleName(command, joined(command, at + 1));
      if (close < 0) return null;
      out += command.slice(at, close + 1);
      at = close;
    } else out += ch;
  }
  return null;
}

/**
 * What a line runs inside `$(…)`, backticks, and `<(…)`, `>(…)`, `=(…)`: commands of
 * their own, wherever they stand, also inside double quotes. Not inside single quotes,
 * where nothing is run. Each is found once, whole: what is nested in one is found when
 * that one is looked at in its turn (looking at every nested one from every level took a
 * time that grew without bound). Null when one is not closed: the line cannot be read
 * with certainty. Given a line that `plain` has taken the comments out of.
 */
function substituted(command: string): string[] | null {
  const found: string[] = [];
  let double = false;
  for (let at = 0; at < command.length; at++) {
    const ch = command[at] as string;
    if (ch === "\\") at += 1;
    else if (ch === '"') double = !double;
    else if (ch === "'" && !double) {
      const close = command.indexOf("'", at + 1);
      if (close < 0) return null;
      at = close;
    } else if (ch === "`") {
      const close = command.indexOf("`", at + 1);
      if (close < 0) return null;
      found.push(command.slice(at + 1, close));
      at = close;
    } else if (
      command[at + 1] === "(" &&
      (ch === "$" || (!double && (ch === "<" || ch === ">" || ch === "=")))
    ) {
      const close = closingBracket(command, at + 2, 0);
      if (close < 0) return null;
      found.push(command.slice(at + 2, close));
      at = close;
    }
  }
  return found;
}

function judge(given: string, depth: number, budget: Budget): string | null {
  budget.left -= 1 + Math.ceil(given.length / 64);
  // Too long, too deep or too much to judge in the time a person would wait: asked about.
  if (given.length > MAX_JUDGED || depth > 6 || budget.left < 0) return WHY.hidden;
  if (given.includes("\r")) return WHY.hidden;
  const command = plain(given);
  if (command === null) return WHY.hidden;
  // What a command puts in place of `$(…)` is run first, and is judged as what it is.
  const inside = substituted(command);
  if (!inside) return WHY.hidden;
  for (const one of inside) {
    const why = judge(one, depth + 1, budget);
    if (why) return why;
  }
  // A function that calls itself without end.
  if (/:\(\)\s*\{/.test(command)) return WHY.stops;
  const commands = parse(command);
  // What cannot be read with certainty is asked about: it may be anything.
  if (!commands) return WHY.hidden;
  for (let at = 0; at < commands.length; at++) {
    const one = commands[at] as Command;
    const first = one.words[0] ?? "";
    // A function, a `case`, and a pattern that runs code (zsh's `x(e:…:)`): what they run
    // is not told apart here. Asked about.
    const begins = program(one.words).name;
    if (
      first === "case" ||
      first === "function" ||
      begins === "case" ||
      begins === "function" ||
      one.globs
    )
      return WHY.hidden;
    const why = riskOf(
      one.words,
      one.open,
      one.piped ? program(commands[at - 1]?.words ?? []).name : null,
      depth,
      budget,
    );
    if (why) return why;
  }
  return null;
}

/** Why a command asks the person whatever the mode they chose but full access, or null when it does not. */
export function risk(command: string): string | null {
  try {
    // A bound on all that is looked at for one command, however it is written: judging
    // happens while everyone's requests wait.
    return judge(command, 0, { left: 6000 });
  } catch {
    // Whatever went wrong in reading it, it was not read.
    return WHY.hidden;
  }
}
