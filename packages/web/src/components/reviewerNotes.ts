// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { PromptAttachment, ReviewerNote } from "@bivy/core";
import { controller } from "../store/useStore.js";

/** Pictures remain untrusted feedback, just like the words accompanying them. */
export function notePictures(notes: readonly ReviewerNote[]): PromptAttachment[] {
  return notes.flatMap(note => note.shot ? [{ kind: "image" as const, name: "Reviewer note (approximate).png", mimeType: "image/png", hash: note.shot.hash, size: note.shot.size, createdAt: note.at, description: "Retaken on the machine; may differ from the reviewer's browser." }] : []);
}

/** Resolve before drafting so sending works just like a normal image upload. */
export async function noteAttachments(notes: readonly ReviewerNote[]): Promise<PromptAttachment[]> {
  return Promise.all(notePictures(notes).map(async picture => {
    const image = await controller.fetchAttachment(picture.hash!, picture.createdAt);
    if (!image) throw new Error("A reviewer picture is no longer available. The notes have not been added.");
    return { ...picture, ...image };
  }));
}
