import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import OpenAI from "openai";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { map } from "modern-async";
import { paginate } from "./helpers";

export const createAssistant = internalAction({
  args: {},
  handler: async () => {
    const openai = new OpenAI();
    const assistant = await openai.beta.assistants.create({
      instructions:
        "Answer the user questions based on the provided documents " +
        "or report that the question cannot be answered based on " +
        "these documents. Keep the answer informative but brief, " +
        "do not enumerate all possibilities.",
      model: "gpt-4-1106-preview",
      tools: [{ type: "retrieval" }],
    });
    return assistant.id;
  },
});

export const uploadAllDocuments = internalAction({
  args: {},
  handler: async (ctx) => {
    await paginate(ctx, "documents", 20, async (documents) => {
      await ctx.runAction(internal.init.uploadDocuments, {
        documentIds: documents.map((doc) => doc._id),
      });
    });
  },
});

export const uploadDocuments = internalAction({
  args: {
    documentIds: v.array(v.id("documents")),
  },
  handler: async (ctx, { documentIds }) => {
    const openai = new OpenAI();
    await map(documentIds, async (documentId) => {
      const document = await ctx.runQuery(internal.init.getDocument, {
        documentId,
      });
      if (document === null || document.fileId !== null) {
        return;
      }
      const { text, url } = document;
      const blob = new File([text], fileName(url));

      const { id: fileId } = await openai.files.create({
        file: blob,
        purpose: "assistants",
      });
      await openai.beta.assistants.files.create(process.env.ASSISTANT_ID!, {
        file_id: fileId,
      });
      await ctx.runMutation(internal.init.saveFileId, { documentId, fileId });
    });
  },
});

function fileName(url: string) {
  return url.replace(/^.*\/([^/]+)/, "$1") + ".md";
}

export const getDocument = internalQuery(
  async (ctx, { documentId }: { documentId: Id<"documents"> }) => {
    return await ctx.db.get(documentId);
  }
);

export const saveFileId = internalMutation(
  async (
    ctx,
    { documentId, fileId }: { documentId: Id<"documents">; fileId: string }
  ) => {
    await ctx.db.patch(documentId, { fileId });
  }
);
