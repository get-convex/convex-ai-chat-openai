/* eslint-disable no-constant-condition */
import { v } from "convex/values";
import { map, sleep } from "modern-async";
import OpenAI from "openai";
import { MessageContentText } from "openai/resources/beta/threads/messages/messages";
import { internal } from "./_generated/api";
import {
  ActionCtx,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";

export const answer = internalAction({
  args: {
    sessionId: v.string(),
    message: v.string(),
  },
  handler: async (ctx, { sessionId, message }) => {
    const openai = new OpenAI();

    const threadId = await getOrCreateThread(ctx, openai, sessionId);

    const { id: lastMessageId } = await openai.beta.threads.messages.create(
      threadId,
      { role: "user", content: message }
    );

    const { id: runId } = await openai.beta.threads.runs.create(threadId, {
      assistant_id: process.env.ASSISTANT_ID!,
    });

    await pollForAnswer(ctx, { threadId, sessionId, lastMessageId, runId });
  },
});

const getOrCreateThread = async (
  ctx: ActionCtx,
  openai: OpenAI,
  sessionId: string
) => {
  const thread = await ctx.runQuery(internal.serve.getThread, { sessionId });
  if (thread !== null) {
    return thread.threadId;
  }
  const { id: threadId } = await openai.beta.threads.create();
  await ctx.runMutation(internal.serve.saveThread, {
    sessionId,
    threadId,
  });
  return threadId;
};

export const getThread = internalQuery(
  async (ctx, { sessionId }: { sessionId: string }) => {
    return await ctx.db
      .query("threads")
      .withIndex("bySessionId", (q) => q.eq("sessionId", sessionId))
      .unique();
  }
);

export const saveThread = internalMutation(
  async (
    ctx,
    { sessionId, threadId }: { sessionId: string; threadId: string }
  ) => {
    await ctx.db.insert("threads", { sessionId, threadId });
  }
);

async function pollForAnswer(
  ctx: ActionCtx,
  args: {
    sessionId: string;
    threadId: string;
    runId: string;
    lastMessageId: string;
  }
) {
  const { sessionId, threadId, runId, lastMessageId } = args;
  const openai = new OpenAI();
  while (true) {
    await sleep(500);
    const run = await openai.beta.threads.runs.retrieve(threadId, runId);
    switch (run.status) {
      case "failed":
      case "expired":
      case "cancelled":
        await ctx.runMutation(internal.serve.addMessage, {
          text: "I cannot reply at this time. Reach out to the team on Discord",
          sessionId,
        });
        return;
      case "completed": {
        const { data: newMessages } = await openai.beta.threads.messages.list(
          threadId,
          { after: lastMessageId, order: "asc" }
        );
        await map(newMessages, async ({ content }) => {
          const text = content
            .filter((item): item is MessageContentText => item.type === "text")
            .map(({ text }) => text.value)
            .join("\n\n");
          await ctx.runMutation(internal.serve.addMessage, { text, sessionId });
        });
        return;
      }
    }
  }
}

export const addMessage = internalMutation(
  async (ctx, { text, sessionId }: { text: string; sessionId: string }) => {
    await ctx.db.insert("messages", {
      isViewer: false,
      text,
      sessionId,
    });
  }
);
