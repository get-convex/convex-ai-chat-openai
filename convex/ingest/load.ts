/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */

import { CheerioAPI, load } from "cheerio";
import { v } from "convex/values";
import { map } from "modern-async";
import { internal } from "../_generated/api";
import { internalAction, internalMutation } from "../_generated/server";

export const scrapeSite = internalAction({
  args: {
    sitemapUrl: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { sitemapUrl, limit }) => {
    const response = await fetch(sitemapUrl);
    const xml = await response.text();
    const $ = load(xml, { xmlMode: true });
    const urls = $("url > loc")
      .map((_i, elem) => $(elem).text())
      .get()
      .slice(0, limit);
    await map(urls, (url) =>
      ctx.runAction(internal.ingest.load.fetchSingle, { url })
    );
  },
});

export const fetchSingle = internalAction({
  args: {
    url: v.string(),
  },
  handler: async (ctx, { url }) => {
    const response = await fetch(url);
    const text = parsePage(await response.text());
    if (text.length > 0) {
      await ctx.runMutation(internal.ingest.load.saveDocument, { url, text });
    }
  },
});

export const saveDocument = internalMutation(
  async (ctx, { url, text }: { url: string; text: string }) => {
    const existing = await ctx.db
      .query("documents")
      .withIndex("byUrl", (q) => q.eq("url", url))
      .unique();
    const newDocument = { url, text, fileId: null };
    if (existing == null) {
      await ctx.db.insert("documents", newDocument);
    } else if (existing.text !== text) {
      await ctx.db.replace(existing._id, newDocument);
    }
  }
);

function parsePage(text: string) {
  const $ = load(text);
  return parse($, $(".markdown"))
    .replace(/(?:\n\s+){3,}/g, "\n\n")
    .trim();
}

function parse($: CheerioAPI, element: any) {
  let result = "";

  $(element)
    .contents()
    .each((_, el) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
      if (el.type === "text") {
        result += $(el).text().trim() + " ";
        return;
      }
      const tagName = (el as any).tagName;
      switch (tagName) {
        case "code":
          if ($(el).has("span").length > 0) {
            result +=
              "```\n" +
              $(el)
                .children()
                .map((_, line) => $(line).text())
                .get()
                .join("\n") +
              "\n```\n";
            return;
          }
          result += " `" + $(el).text() + "` ";
          return;
        case "a": {
          if ($(el).hasClass("hash-link")) {
            return;
          }
          let href = $(el).attr("href")!;
          if (href.startsWith("/")) {
            href = "https://docs.convex.dev" + href;
          }
          result += " [" + $(el).text() + "](" + href + ") ";
          return;
        }
        case "strong":
        case "em":
          result += " " + $(el).text() + " ";
          return;
        case "h1":
        case "h2":
        case "h3":
        case "h4":
        case "h5":
          result += "#".repeat(+tagName.slice(1)) + " " + $(el).text() + "\n\n";
          return;
      }
      result += parse($, el);
      result += "\n\n";
    });

  return result;
}
