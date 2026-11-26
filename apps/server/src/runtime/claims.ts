/**
 * A reply that says work was done which its own steps do not show (CHA-186).
 *
 * A model sometimes writes "Both pages loaded" or "it answered with status 200" without
 * having called a tool. Nothing unsafe happens: the gateway was never asked. But the
 * person reads a result that does not exist. So a finished reply is read against what the
 * run did, and when its words claim more, the conversation says what is true: no tool was
 * used, or nothing was saved or sent.
 *
 * What is said is a fact about the steps, whatever the words meant. The words only decide
 * whether saying it is worth the person's attention. A line under every explanation would
 * teach people to ignore it, so this reads narrowly: a sentence in which the agent itself
 * reports a finished action on something outside the reply. Sentences that explain, ask,
 * suppose or deny are left alone, and so is a reply that offers a draft. A claim in words
 * this does not know goes unmarked. Every pattern is bounded, so reading takes time in
 * proportion to the reply's length.
 */

/** Words allowed between "I have" and the verb: never "not". */
const SOFT = "(?:(?:just|now|already|successfully|also|gone ahead and)\\s+){0,2}";
const I = `(?:\\bI(?:'ve|’ve| have| just)?|\\bwe(?:'ve|’ve| have))\\s+${SOFT}`;
/** Things that exist outside the reply itself. */
const MADE =
  "(?:file|document|doc|spreadsheet|workbook|deck|presentation|slides|pdf|event|ticket|record|meeting|reminder)";

/** The agent says it saved, sent or changed something. */
const CHANGED: readonly RegExp[] = [
  new RegExp(
    `${I}(?:saved|sent|posted|emailed|e-mailed|uploaded|deleted|scheduled|submitted|forwarded|booked|pinged|messaged|remembered|closed)\\b`,
    "i",
  ),
  new RegExp(`${I}(?:created|generated|added|made|put)\\b[^,;:]{0,60}\\b${MADE}\\b`, "i"),
  new RegExp(`${I}(?:put|added)\\b[^,;:]{0,40}\\bon (?:your|the) calendar\\b`, "i"),
  /\b(?:has|have) (?:now |just |already |successfully )?been (?:saved|sent|posted|emailed|uploaded|deleted|scheduled|submitted|forwarded|booked)\b/i,
  /\b(?:e-?mail|message|invite|invitation) (?:went|has gone) out\b/i,
  /(?:已经?|刚刚?|成功|顺利)(?:为您|为你|帮您|帮你|给您|给你)?(?:把|将)?[^，。；！？\s]{0,12}?(?:保存|发送|发出|发给|转发|提交|上传|删除|存到|存入|写入|创建|新建|安排|预订|加好|记住|记下)(?!的|后|之后|以后|时)/,
  /(?:保存|发送|提交|上传|删除|写入|创建|转发)(?:成功|完成|好了|完毕)(?!的|后|之后|以后|时)/,
  /(?:记住了|记下了)/,
];

/** The agent says it read or asked something outside the conversation. */
const READ: readonly RegExp[] = [
  new RegExp(
    `${I}(?:searched|looked up|fetched|loaded|opened|visited|checked|read|queried|called|retrieved|pulled|ran|went to)\\b[^,;:]{0,60}\\b(?:web|internet|online|page|pages|site|website|url|link|address|search|results?|calendar|mail|inbox|mailbox|emails?|chats?|knowledge base|system|connector|api|endpoint|folder|drive|query)\\b`,
    "i",
  ),
  /\b(?:pages?|sites?|addresses|urls?|links?|requests?|calls?)\b[^,;:]{0,40}\b(?:loaded|opened|returned|responded|answered|succeeded|came back)\b/i,
  /\b(?:answered|responded|returned|replied|came back)(?: with|:)? (?:a |an |the )?(?:http )?(?:status )?(?:code )?(?:of )?[1-5]\d\d\b/i,
  /\bloaded (?:successfully|fine|correctly)\b/i,
  /(?:已经?|刚刚?|成功|顺利)(?:为您|为你|帮您|帮你)?(?:搜索|查询|检索|查看|查阅|打开|访问|加载|读取|调用|请求)(?!的|后|之后|以后|时)/,
  /我(?:查了|搜了|访问了|打开了|看了一下)/,
  /(?:加载|访问|打开|读取|调用|请求)(?:成功|完成)(?!的|后|之后|以后|时)/,
  /(?:返回|响应|应答)了(?:状态码?)?\s?[1-5]\d\d/,
];

/** A sentence that explains, asks, supposes or denies reports nothing done. */
const NOT_A_REPORT =
  /[?？]\s*$|\b(?:if|once|when|whenever|after|before|until|unless|would|should|could|can|may|might|will|shall|not|never|nothing|no|none|yet|usually|normally|typically|means?|by default|you|your request)\b|n't|n’t|如果|假如|一旦|之后|以后|时，|的时候|会|将会|不|没|未|尚|无法|可以|能够|请|吗|通常|一般|默认|表示|说明|意味/i;
/** Text about the reply's own contents: "the list above", "your draft". */
const ABOUT_ITSELF =
  /\b(?:above|below|draft|outline|paragraph|sentence|section|wording|this reply|the list|the table)\b|上面|下面|以上|以下|上述|草稿|列表/i;
/** A reply that hands over a draft or a template quotes someone else's words. */
const OFFERS_TEXT =
  /^(?:subject|to|dear|主题|标题|收件人)\b\s?[:：,，]|\b(?:draft|template)\b|草稿|模板|范文/im;

/** What a run did, as far as this reading needs it. */
export interface Done {
  /** A tool call came back without an error. */
  any: boolean;
  /** One of them saved, sent or changed something. */
  changed: boolean;
}

/**
 * What to tell the person about a finished reply, if anything.
 * - "none": the reply reports work done, and no tool was used in it at all.
 * - "read": it reports saving, sending or changing, and its steps only read.
 */
export function unbacked(reply: string, done: Done): "none" | "read" | null {
  if (done.changed) return null;
  const said = reply
    .slice(0, 20_000)
    // What is fenced or quoted is shown to the person, not said by the agent about itself.
    .replace(/https?:\/\/[^\s<>"'）)]{1,2000}/g, " link ")
    .replace(/```[^`]{0,20000}(?:```|$)/g, " ")
    .replace(
      /"[^"\n]{0,2000}"|“[^”\n]{0,2000}”|「[^」\n]{0,2000}」|(?<![A-Za-z])'[^'\n]{3,2000}'(?![A-Za-z])/g,
      " ",
    );
  if (OFFERS_TEXT.test(said)) return null;
  const reports = said
    .split(/(?<=[.!?])\s+|(?<=[。！？\n])/)
    .filter((sentence) => sentence.trim() && !NOT_A_REPORT.test(sentence));
  const claims = (patterns: readonly RegExp[]) =>
    reports.some((sentence) => patterns.some((pattern) => pattern.test(sentence)));
  // A change to the reply's own text ("I've added two points to the list above") is not one outside it.
  const changed = reports.some(
    (sentence) => !ABOUT_ITSELF.test(sentence) && CHANGED.some((pattern) => pattern.test(sentence)),
  );
  if (!done.any) return changed || claims(READ) ? "none" : null;
  return changed ? "read" : null;
}
