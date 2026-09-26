// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { Type, type TSchema } from "typebox";

const request = { requestId: Type.Optional(Type.String()) };
const session = { sessionId: Type.String() };
const optionalSession = { sessionId: Type.Optional(Type.String()) };

/** Declarative validation at the client-command boundary. A command absent from
 * this table remains migration-compatible; adding validation is one data row. */
export const CLIENT_COMMAND_SCHEMAS: Readonly<Record<string, TSchema>> = {
  ping: Type.Object(request),
  "apps.list": Type.Object({ ...request, ...optionalSession }),
  "artifacts.list": Type.Object(request),
  "apps.publish": Type.Object({ ...request, ...session, manifest: Type.Unknown() }),
  "apps.offers": Type.Object({ ...request, ...session }),
  "apps.adopt": Type.Object({ ...request, ...session, port: Type.Integer({ minimum: 1024, maximum: 65535 }) }),
  "apps.open": Type.Object({ ...request, ...session, appId: Type.String(), viewId: Type.String(), returnTo: Type.Optional(Type.String({ maxLength: 2048 })), direct: Type.Optional(Type.Boolean()), scale: Type.Optional(Type.Integer({ minimum: 1, maximum: 2 })), path: Type.Optional(Type.String({ maxLength: 2048 })) }),
  "apps.shot": Type.Object({ ...request, ...session, appId: Type.Optional(Type.String()), widths: Type.Optional(Type.Array(Type.Integer(), { maxItems: 4 })), themes: Type.Optional(Type.Array(Type.Union([Type.Literal("light"), Type.Literal("dark")]), { maxItems: 2 })), path: Type.Optional(Type.String({ maxLength: 2048 })) }),
  "apps.present": Type.Object({ ...request, ...session, target: Type.Optional(Type.String({ maxLength: 200 })), path: Type.Optional(Type.String({ maxLength: 2048 })), note: Type.Optional(Type.String({ maxLength: 2000 })) }),
  "apps.showMe": Type.Object({ ...request, ...session, appId: Type.Optional(Type.String()) }),
  "apps.mute": Type.Object({ ...request, ...session }),
  "apps.reviewMode": Type.Object({ ...request, ...session, appId: Type.String(), mode: Type.Union([Type.Literal("ready"), Type.Literal("every"), Type.Literal("off")]) }),
  "apps.annotate": Type.Object({ ...request, ...session, appId: Type.String(), viewId: Type.String(), path: Type.Optional(Type.String({ maxLength: 2048 })),
    viewport: Type.Object({ width: Type.Number(), height: Type.Number() }), scroll: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number() })),
    dpr: Type.Optional(Type.Number()), theme: Type.Optional(Type.Union([Type.Literal("light"), Type.Literal("dark")])), compare: Type.Optional(Type.Integer({ minimum: 0 })),
    strokes: Type.Array(Type.Object({ tool: Type.Union([Type.Literal("pen"), Type.Literal("box")]), points: Type.Array(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 }), { maxItems: 10000 }) }), { minItems: 1, maxItems: 50 }),
    signals: Type.Optional(Type.Record(Type.String(), Type.Boolean())) }),
  "apps.clearNotes": Type.Object({ ...request, ...session, appId: Type.String(), viewId: Type.String() }),
  "apps.logs": Type.Object({ ...request, ...session, appId: Type.String(), viewId: Type.String() }),
  "apps.share": Type.Object({ ...request, ...session, appId: Type.String(), viewId: Type.String() }),
  "apps.revoke": Type.Object({ ...request, ...session, appId: Type.String(), viewId: Type.String() }),
  "apps.remove": Type.Object({ ...request, ...session, appId: Type.String() }),
  "credentials.native.preview": Type.Object({ ...request, label: Type.Optional(Type.String({ maxLength: 100 })) }),
  "credentials.native.import": Type.Object({
    ...request,
    previewId: Type.String({ minLength: 1, maxLength: 100 }),
    agents: Type.Array(Type.Union([Type.Literal("claude"), Type.Literal("codex"), Type.Literal("grok")]), { minItems: 1, maxItems: 3, uniqueItems: true }),
    sync: Type.Union([Type.Literal("node"), Type.Literal("account")]),
  }),
  "attachment.fetch": Type.Object({ ...request, hash: Type.String() }),
  "session.pause": Type.Object(session),
  "session.presence.get": Type.Object({ ...request, ...session }),
  "session.presence.draft": Type.Object({ ...request, ...session, device: Type.Object({ id: Type.String({ maxLength: 100 }), label: Type.Optional(Type.String({ maxLength: 200 })) }), text: Type.String({ maxLength: 20_000 }) }),
  "session.resume": Type.Object(session),
  "session.question.answer": Type.Object({ ...optionalSession, requestId: Type.String(), answers: Type.Optional(Type.Record(Type.String(), Type.String())) }),
  "session.replay": Type.Object({ ...session, afterSeq: Type.Optional(Type.Number()) }),
  "session.checkpoints": Type.Object(session),
  "session.rewind": Type.Object({ ...session, checkpointId: Type.String() }),
  "session.revert_file": Type.Object({ ...session, path: Type.String(), content: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
  "session.pr.refresh": Type.Object({ ...request, ...optionalSession, path: Type.Optional(Type.String()) }),
  "node.rename": Type.Object({ name: Type.String() }),
  "node.settings.get": Type.Object(request),
  "node.settings.set": Type.Object({ ...request, settings: Type.Record(Type.String(), Type.Unknown()) }),
  "node.stats": Type.Object(optionalSession),
  "session.rename": Type.Object({ ...session, name: Type.String() }),
  abort: Type.Object(optionalSession),
  "session.turn_attention.resolve": Type.Object({ ...session, action: Type.Union([Type.Literal("stop"), Type.Literal("continue")]) }),
  "session.limit_retry": Type.Object({ ...session, enabled: Type.Boolean() }),
  "session.command.invoke": Type.Object({ ...session, name: Type.String(), args: Type.Optional(Type.String()) }),
  "branches.list": Type.Object({ repo: Type.String() }),
  "history": Type.Object({ ...request, ...optionalSession, have: Type.Optional(Type.Number()), haveToken: Type.Optional(Type.String()) }),
};
