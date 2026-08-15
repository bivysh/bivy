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
  "attachment.fetch": Type.Object({ ...request, hash: Type.String() }),
  "session.pause": Type.Object(session),
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
  "session.command.invoke": Type.Object({ ...session, name: Type.String(), args: Type.Optional(Type.String()) }),
  "branches.list": Type.Object({ repo: Type.String() }),
  "history": Type.Object({ ...request, ...optionalSession, have: Type.Optional(Type.Number()), haveToken: Type.Optional(Type.String()) }),
};
