import { describe, expect, it } from "vitest";
import { unbacked } from "./claims.js";

const nothing = { any: false, changed: false };
const onlyRead = { any: true, changed: false };
const changed = { any: true, changed: true };

describe("a reply read against what its run did (CHA-186)", () => {
  it("says so when a reply reports work and no tool was used", () => {
    for (const reply of [
      // The two replies QA saw.
      "Both pages loaded: https://example.com?qa=two returned the same 'Example Domain' page, and https://example.com?qa=three also loaded successfully.",
      "QA-D Echo answered with status 200.",
      "I've sent the email to the team.",
      "I have just saved it to the documents.",
      "I searched the web and found three results.",
      "I've checked the calendar: Tuesday at 3 is free.",
      "The message has been sent.",
      "I've created a spreadsheet with the figures.",
      "Got it, I've remembered that.",
      "I booked the meeting room for 3 pm.",
      "I've forwarded the message to Lei.",
      "I ran the query and there are 42 open tickets.",
      "I've put the event on the calendar for Tuesday.",
      "The API responded: 200 OK.",
      "The email went out to the team a minute ago.",
      "已为您发送邮件。",
      "我已经把邮件发给了张三。",
      "我已经搜索了相关资料。",
      "我查了一下官网，价格是 20 元。",
      "文件保存成功。",
      "文件已经存到网盘里了。",
      "已转发给李雷。",
      "接口返回了 200。",
      "好的，记住了。",
    ])
      expect(unbacked(reply, nothing), reply).toBe("none");
  });

  it("says nothing was saved or sent when the steps only read", () => {
    expect(unbacked("I read the page and I've sent the summary to Lei.", onlyRead)).toBe("read");
    expect(unbacked("已读取文档，并已为您保存。", onlyRead)).toBe("read");
    // Reading is what it did: speaking of it claims nothing more.
    expect(
      unbacked("I searched the web: the page loaded and answered with status 200.", onlyRead),
    ).toBeNull();
  });

  it("leaves alone a reply that explains, asks, supposes, denies or offers a draft", () => {
    for (const reply of [
      "The capital of France is Paris.",
      "I have not sent anything yet. Shall I?",
      "Nothing has been sent yet.",
      "No file was saved.",
      "I would have sent it, but I don't have access to email.",
      "I can't read that page without your approval.",
      "Once the request is sent, you'll get an email.",
      "When the form is submitted, the data is stored in the database.",
      "In React, state is updated asynchronously.",
      "The file is saved in UTF-8 by default in most editors.",
      "An HTTP status of 404 means the page was not found.",
      "The status code 200 means OK.",
      "Your API call returned a 401? That usually means the token expired.",
      "If the page loaded slowly, try clearing your cache.",
      "Once the links are opened in a new tab, close the old one.",
      "I've updated the list above to include Paris.",
      "I've removed the duplicate sentence from your draft.",
      "I've added two points to the list above.",
      "I've written a short summary below.",
      "I've made a note of the three options below.",
      "If I sent the email now, it would arrive tomorrow.",
      "Should I send it once I've saved the draft?",
      "Once you've successfully submitted the form, wait for the email.",
      "You could save the file and send it yourself.",
      "Subject: Update\n\nHi Sam, I've sent the contract over for review.",
      "Here is a template: 'We have successfully submitted your application.'",
      "Here is a draft you could send:\n\nDear Lei, the report is attached.",
      "HTTP 状态码 404 表示页面不存在。",
      "如果接口返回了 500，说明服务器出错。",
      "请求成功时返回状态码 200。",
      "这个函数调用成功后会返回一个 Promise。",
      "已更新上面的列表。",
      "已经删除的文件可以在回收站找到。",
      "这些数据已更新至2024年。",
      "数据保存完成后，页面会自动刷新。",
      "发送成功后会显示提示。",
      "我会记住你说的，不过只在这次对话中。",
      "我还没有发送，需要我现在发吗？",
      "以下是邮件草稿：您好，我已发送合同，请查收。",
      "下面是我写的总结。",
      "```\nI've sent the email.\n```",
    ])
      expect(unbacked(reply, nothing), reply).toBeNull();
    expect(unbacked("I've sent the email.", changed)).toBeNull();
  });

  it("reads a long reply in time that grows with its length", () => {
    for (const piece of ["I have ", "status ", "已", "pages ", '"', "```a"]) {
      const started = performance.now();
      unbacked(piece.repeat(Math.ceil(20_000 / piece.length)), nothing);
      expect(performance.now() - started, piece).toBeLessThan(300);
    }
  });
});
